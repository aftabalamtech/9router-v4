/**
 * Regression tests for the translator registry.
 *
 * Guards against the dual CJS/ESM module instance bug: ensureInitialized()
 * previously require()-loaded the ESM translator files, creating a second
 * module instance whose register() calls landed in a registry that
 * translateRequest/translateResponse never read. Symptom: Antigravity
 * streaming chunks reached clients untranslated → "Provider returned an
 * empty response." in Playground.
 *
 * Run: node --test test/antigravity-translators.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { translateResponse, translateRequest, initTranslators, initState } from "../open-sse/translator/index.js";
import { parseSSELine } from "../open-sse/utils/streamHelpers.js";

test("antigravity SSE chunk translates to OpenAI chat.completion.chunk", async () => {
  await initTranslators();

  const line = 'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":2,"totalTokenCount":12},"modelVersion":"gemini-3-flash","responseId":"req_xyz"}}';
  const parsed = parseSSELine(line.trim(), "antigravity");
  assert.ok(parsed, "SSE line must parse");

  const state = { ...initState("openai"), provider: "antigravity" };
  const out = await translateResponse("antigravity", "openai", parsed, state);

  assert.ok(Array.isArray(out) && out.length > 0, "translation must produce chunks");
  const roleChunk = out.find((c) => c?.choices?.[0]?.delta?.role);
  const textChunk = out.find((c) => c?.choices?.[0]?.delta?.content);
  assert.ok(roleChunk, "first chunk must carry the assistant role delta");
  assert.equal(textChunk?.choices?.[0]?.delta?.content, "Hello", "text must be extracted into delta.content");
  assert.equal(textChunk?.object, "chat.completion.chunk");
});

test("antigravity finishReason STOP maps to finish_reason stop", async () => {
  await initTranslators();
  const line = 'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}],"modelVersion":"m","responseId":"r1"}}';
  const parsed = parseSSELine(line.trim(), "antigravity");
  const state = { ...initState("openai"), provider: "antigravity" };
  const out = await translateResponse("antigravity", "openai", parsed, state);
  assert.ok(out.some((c) => c?.choices?.[0]?.finish_reason === "stop"), "finish chunk must be emitted");
});

test("antigravity request translation registers (openai → antigravity envelope)", async () => {
  await initTranslators();
  const body = {
    model: "gemini-3-flash",
    messages: [{ role: "user", content: "hi" }],
  };
  const out = await translateRequest("openai", "antigravity", "gemini-3-flash", body, false, { projectId: "p1" }, "antigravity");
  assert.equal(out.request?.constructor, Object);
  assert.ok(out.request.contents, "envelope must contain contents");
  assert.equal(out.userAgent, "antigravity");
});

test("gemini and claude response translators are registered too", async () => {
  await initTranslators();

  const gemOut = await translateResponse("gemini", "openai", { candidates: [{ content: { role: "model", parts: [{ text: "yo" }] } }] }, initState("openai"));
  assert.ok(gemOut.some((c) => c?.choices?.[0]?.delta?.content === "yo"), "gemini → openai must work");

  const claudeOut = await translateResponse("claude", "openai", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hey" } }, initState("openai"));
  assert.ok(claudeOut.some((c) => c?.choices?.[0]?.delta?.content === "hey"), "claude → openai must work");
});
