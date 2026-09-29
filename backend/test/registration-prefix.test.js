// Regression tests for the two prefix bugs found against the live API:
//  1. a prefix change (ag -> ago) for the same upstream model was rejected
//     because the short alias collided;
//  2. a real upstream id containing a slash was silently truncated, turning
//     "openrouter/anthropic/claude-3" into "openrouter/claude-3".
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegisteredId, splitRegisteredId } from "../src/shared/constants/modelCapabilities.js";

// The route composes ids with these; mirror the decision the route makes so the
// rule itself is pinned.
function resolveRegistration(prefix, rawModelId) {
  let effectivePrefix = String(prefix || "").trim();
  let effectiveModelId = String(rawModelId).trim();
  if (effectiveModelId.includes("/")) {
    const split = splitRegisteredId(effectiveModelId);
    if (!split.valid) return { error: "bad id" };
    const embeddedPrefix = split.prefix;
    if (effectivePrefix && embeddedPrefix === effectivePrefix) {
      effectiveModelId = split.modelId;
    } else if (!effectivePrefix) {
      effectivePrefix = embeddedPrefix;
      effectiveModelId = split.modelId;
    }
  }
  if (!effectivePrefix) return { error: "prefix required" };
  return { registeredId: buildRegisteredId(effectivePrefix, effectiveModelId), effectivePrefix, effectiveModelId };
}

test("a leading path segment in a real upstream id is NOT eaten", () => {
  // The bug: prefix "openrouter" + modelId "anthropic/claude-3" lost "anthropic/".
  const r = resolveRegistration("openrouter", "anthropic/claude-3");
  assert.equal(r.registeredId, "openrouter/anthropic/claude-3");
  assert.equal(r.effectiveModelId, "anthropic/claude-3");
});

test("a genuinely redundant prefix is still collapsed", () => {
  // prefix "ag" + modelId "ag/x" is the same model written out twice.
  const r = resolveRegistration("ag", "ag/gemini-3.7-flash-low");
  assert.equal(r.registeredId, "ag/gemini-3.7-flash-low");
  assert.equal(r.effectiveModelId, "gemini-3.7-flash-low");
});

test("a fully-qualified id supplies its own prefix", () => {
  const r = resolveRegistration("", "ag/gemini-3.7-flash-low");
  assert.equal(r.registeredId, "ag/gemini-3.7-flash-low");
  assert.equal(r.effectivePrefix, "ag");
});

test("changing the prefix produces a distinct id without touching the original", () => {
  const original = resolveRegistration("ag", "gemini-3.7-flash-low").registeredId;
  const changed = resolveRegistration("ago", "gemini-3.7-flash-low").registeredId;
  assert.equal(original, "ag/gemini-3.7-flash-low");
  assert.equal(changed, "ago/gemini-3.7-flash-low");
  assert.notEqual(original, changed);
  // The upstream id — what actually gets sent to the provider — is identical.
  assert.equal(splitRegisteredId(original).modelId, splitRegisteredId(changed).modelId);
});

test("deeply nested upstream ids survive intact", () => {
  const r = resolveRegistration("openrouter", "meta-llama/llama-3/405b");
  assert.equal(r.registeredId, "openrouter/meta-llama/llama-3/405b");
  assert.equal(splitRegisteredId(r.registeredId).modelId, "meta-llama/llama-3/405b");
});
