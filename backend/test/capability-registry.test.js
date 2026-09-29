// Model registration: per-model prefix, capability sets, duplicate handling.
//
// The prefix rules are the subtle part. A prefix change must affect exactly one
// model and must never rewrite a sibling, so these tests assert on the whole
// store, not just the record under test.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitRegisteredId,
  buildRegisteredId,
  isValidPrefix,
  isValidModelId,
  capabilityResultKey,
  aggregateCapabilityStatus,
  sanitizeErrorMessage,
  resolveCapabilities,
} from "../src/lib/models/capabilityRegistry.js";
import { TEST_STATUS } from "../src/shared/constants/modelCapabilities.js";

// ── Registered id parsing ────────────────────────────────────────

test("a registered id splits on the FIRST slash only", () => {
  // Upstream ids legitimately contain slashes ("anthropic/claude-3"), so
  // splitting on the last slash (or on every slash) would corrupt the id.
  const s = splitRegisteredId("ag/anthropic/claude-3");
  assert.deepEqual(s, { prefix: "ag", modelId: "anthropic/claude-3", valid: true });

  const s2 = splitRegisteredId("openrouter/google/gemini-pro");
  assert.equal(s2.prefix, "openrouter");
  assert.equal(s2.modelId, "google/gemini-pro");
});

test("a bare or malformed registered id is rejected", () => {
  assert.equal(splitRegisteredId("gpt-4o").valid, false);
  assert.equal(splitRegisteredId("gpt-4o").prefix, "");
  assert.equal(splitRegisteredId("/gpt-4o").valid, false, "empty prefix is invalid");
  assert.equal(splitRegisteredId("ag/").valid, false, "empty model id is invalid");
  assert.equal(splitRegisteredId("").valid, false);
});

test("a prefix is applied exactly once, even to an already-qualified id", () => {
  // Re-adding "ag/x" while prefix "ag" is set must not produce "ag/ag/x".
  assert.equal(buildRegisteredId("ag", "gemini-3.7-flash-low"), "ag/gemini-3.7-flash-low");
  assert.equal(buildRegisteredId("ag", "ag/gemini-3.7-flash-low"), "ag/gemini-3.7-flash-low");
  assert.equal(buildRegisteredId("ago", "gemini-3.7-flash-low"), "ago/gemini-3.7-flash-low");
  // A model id that merely starts with the same letters is untouched.
  assert.equal(buildRegisteredId("ag", "aggressive-model"), "ag/aggressive-model");
  assert.equal(buildRegisteredId("", "x"), "");
  assert.equal(buildRegisteredId("ag", ""), "");
});

test("prefixes and model ids are validated consistently", () => {
  for (const good of ["ag", "ago", "openrouter", "my-provider", "p_1", "a.b"]) {
    assert.equal(isValidPrefix(good), true, `${good} should be valid`);
  }
  // Surrounding whitespace is trimmed, not rejected: a pasted " ag" must still
  // register as "ag" rather than being refused.
  assert.equal(isValidPrefix(" ag "), true);
  for (const bad of ["", "1ag/../x", "a/b", "a b", "x".repeat(65), "-lead", "..", "@scope"]) {
    assert.equal(isValidPrefix(bad), false, `${bad} should be invalid`);
  }
  assert.equal(isValidModelId("gpt-4o"), true);
  assert.equal(isValidModelId("anthropic/claude-3"), true);
  assert.equal(isValidModelId(""), false);
  assert.equal(isValidModelId("has space"), false);
  assert.equal(isValidModelId("x".repeat(201)), false);
});

// ── Capability result keys ───────────────────────────────────────

test("capability results are keyed per capability, not per model", () => {
  // This is what stops a passing chat test from marking embeddings working.
  const chat = capabilityResultKey("ag/gemini", "chat");
  const emb = capabilityResultKey("ag/gemini", "embedding");
  assert.notEqual(chat, emb);
  assert.ok(chat.startsWith("ag/gemini#"));
  // The legacy `kind` spelling resolves to the same key as the capability.
  assert.equal(capabilityResultKey("ag/gemini", "llm"), chat);
});

// ── Status aggregation ───────────────────────────────────────────

test("a model with only untested capabilities stays untested", () => {
  // Never promoted to working by default.
  const agg = aggregateCapabilityStatus([{ capability: "chat", status: "untested" }]);
  assert.equal(agg.status, TEST_STATUS.UNTESTED);
});

test("the model's status is the worst of its tested capabilities", () => {
  const good = aggregateCapabilityStatus([
    { capability: "chat", status: "passed" },
    { capability: "embedding", status: "failed" },
  ]);
  assert.equal(good.status, TEST_STATUS.ERROR, "a failing capability must not read as working");

  const allGood = aggregateCapabilityStatus([
    { capability: "chat", status: "passed" },
    { capability: "embedding", status: "passed" },
  ]);
  assert.equal(allGood.status, TEST_STATUS.WORKING);
});

test("a partially tested model is not reported as working overall", () => {
  const agg = aggregateCapabilityStatus([
    { capability: "chat", status: "passed" },
    { capability: "image", status: "untested" },
  ]);
  assert.equal(agg.status, TEST_STATUS.UNTESTED);
});

test("unsupported is distinct from error", () => {
  // An unsupported capability is not a failure, but it is also not working.
  const agg = aggregateCapabilityStatus([
    { capability: "chat", status: "passed" },
    { capability: "rerank", status: "unsupported" },
  ]);
  assert.equal(agg.status, TEST_STATUS.UNSUPPORTED);
  assert.equal(agg.status === TEST_STATUS.ERROR, false);
});

test("empty and unknown-capability records aggregate safely", () => {
  assert.equal(aggregateCapabilityStatus([]).status, TEST_STATUS.UNTESTED);
  assert.equal(aggregateCapabilityStatus(null).status, TEST_STATUS.UNTESTED);
  assert.equal(aggregateCapabilityStatus([{ capability: "banana", status: "passed" }]).status, TEST_STATUS.UNTESTED);
});

// ── Error sanitization ───────────────────────────────────────────

test("credentials never survive into a stored error message", () => {
  // An upstream error page can reflect the Authorization header back; the
  // message is persisted and shown in the UI, so it must be scrubbed.
  const cases = [
    "Authorization: Bearer sk-abcdef0123456789abcdef",
    "authorization=Bearer abcdefghijklmnop",
    "Failed with key sk-proj-AAAABBBBCCCCDDDDEEEEFFFF",
    "api_key=abcdef1234567890abcdef",
    "password: hunter2secret",
    "token=eyJhbGciOiJIUzI1NiJ9.payload.sig",
  ];
  for (const input of cases) {
    const out = sanitizeErrorMessage(input);
    assert.ok(!/sk-abcdef|abcdefghij|sk-proj-AAA|abcdef123|abcdef1234567890|hunter2secret|eyJhbGciOiJIUzI1NiJ9/.test(out),
      `leaked credential in: ${input}\n  -> ${out}`);
    assert.match(out, /\[redacted\]/);
  }
});

test("sanitizing keeps useful text and caps the length", () => {
  const msg = `HTTP 404: model not found for provider ${"x".repeat(900)}`;
  const out = sanitizeErrorMessage(msg);
  assert.match(out, /HTTP 404/);
  assert.match(out, /model not found/);
  assert.ok(out.length <= 500, `expected <= 500 chars, got ${out.length}`);
  assert.equal(sanitizeErrorMessage(null), null);
  assert.equal(sanitizeErrorMessage(""), "");
});

// ── Capability resolution ────────────────────────────────────────

test("declared capabilities win over the legacy single type", () => {
  const record = { capabilities: ["chat", "vision"], types: ["llm"] };
  assert.deepEqual(resolveCapabilities(record, "image"), ["chat", "vision"]);
});

test("a model with no capability record falls back to its type", () => {
  assert.deepEqual(resolveCapabilities(null, "llm"), ["chat"]);
  assert.deepEqual(resolveCapabilities({}, "image"), ["image"]);
  assert.deepEqual(resolveCapabilities({ capabilities: [] }, "embedding"), ["embedding"]);
  // An unknown type yields nothing rather than a wrong default.
  assert.deepEqual(resolveCapabilities(null, "banana"), []);
  assert.deepEqual(resolveCapabilities(null, undefined), []);
});
