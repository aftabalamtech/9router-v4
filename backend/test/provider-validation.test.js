import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-validation-"));
delete process.env.DATABASE_URL;
const moduleUrl = pathToFileURL(new URL("../dist/routes/providers/validate/route.js", import.meta.url).pathname).href;
const { createProviderNode } = await import("../src/lib/localDb.js");
const providerId = "openai-compatible-chat-validation-test";
await createProviderNode({ id: providerId, type: "openai-compatible", name: "Validation Test", prefix: "validation-test", apiType: "chat", baseUrl: "https://api.openai.com/v1" });

async function validateWith({ statusSequence, responseBodies = [], thrown, body = {} }) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  let index = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (thrown) throw thrown;
    const status = statusSequence[Math.min(index, statusSequence.length - 1)];
    const text = responseBodies[Math.min(index, responseBodies.length - 1)] ?? "{}";
    index += 1;
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
  try {
    const { POST_handler } = await import(`${moduleUrl}?case=${Math.random()}`);
    let result;
    const res = {
      status(code) { this.statusCode = code; return this; },
      json(data) { result = data; return data; },
    };
    await POST_handler({ body }, res);
    return { result, calls, statusCode: res.statusCode };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("compatible API key validation trims key and checks upstream models response", async () => {
  const out = await validateWith({
    statusSequence: [200],
    responseBodies: ['{"data":[{"id":"gpt-4o-mini"}]}'],
    body: { provider: providerId, apiKey: "  secret-key  " },
  });
  assert.equal(out.result.valid, true);
  assert.equal(out.calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(out.calls[0].options.headers.Authorization, "Bearer secret-key");
});

test("compatible validation reports invalid credentials accurately", async () => {
  const out = await validateWith({
    statusSequence: [401], responseBodies: ['{"error":{"message":"bad credential"}}'],
    body: { provider: providerId, apiKey: "bad-key" },
  });
  assert.deepEqual(out.result, { valid: false, error: "Invalid API key" });
});

test("compatible validation distinguishes rate limits and upstream failures without chat fallback", async () => {
  for (const [status, expected] of [
    [429, /Rate limited by upstream/],
    [503, /Upstream server error \(HTTP 503\)/],
  ]) {
    const out = await validateWith({
      statusSequence: [status], responseBodies: ['{"error":"failure"}'],
      body: { provider: providerId, apiKey: "key" },
    });
    assert.equal(out.result.valid, false);
    assert.match(out.result.error, expected);
    assert.equal(out.calls.length, 1);
  }
});

test("compatible validation falls back from absent models route to correct chat endpoint", async () => {
  const out = await validateWith({
    statusSequence: [404, 200], responseBodies: ["not found", '{"id":"chatcmpl-test","choices":[]}'],
    body: { provider: providerId, apiKey: "key", defaultModel: "vendor/model-id" },
  });
  assert.equal(out.result.valid, true);
  assert.equal(out.calls[0].url, "https://api.openai.com/v1/models");
  assert.equal(out.calls[1].url, "https://api.openai.com/v1/chat/completions");
  assert.equal(JSON.parse(out.calls[1].options.body).model, "vendor/model-id");
});

test("compatible validation reports malformed model list and network timeout", async () => {
  const malformed = await validateWith({
    statusSequence: [200], responseBodies: ['{"success":true}'],
    body: { provider: providerId, apiKey: "key" },
  });
  assert.equal(malformed.result.valid, false);
  assert.match(malformed.result.error, /malformed data/);

  const timeout = await validateWith({
    statusSequence: [], thrown: Object.assign(new Error("aborted"), { name: "TimeoutError" }),
    body: { provider: providerId, apiKey: "key" },
  });
  assert.equal(timeout.result.valid, false);
  assert.match(timeout.result.error, /timed out/);
});
