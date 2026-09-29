// Auto-Add capability (kind) filtering.
//
// Regression guard for a real failure mode: filtering Auto-Add to "Chat" must
// not silently DISABLE every image model. A kind excluded by the filter has to
// be skipped entirely — neither added nor pushed to the disabled list.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_ADD_KINDS,
  DEFAULT_SYNC_SETTINGS,
  normalizeAutoAddKinds,
  normalizeModelKind,
  normalizeSyncSettings,
  resolveAutoAdd,
} from "../src/lib/models/autoAdd.js";

const row = (id, type, extra = {}) => ({
  id,
  type,
  fullModel: `alias/${id}`,
  isAdded: false,
  ...extra,
});

test("capability kinds are the fixed set the UI offers", () => {
  assert.deepEqual([...AUTO_ADD_KINDS], ["llm", "image", "video", "audio", "embedding"]);
});

test("model kinds normalize to the filter buckets", () => {
  assert.equal(normalizeModelKind("image"), "image");
  assert.equal(normalizeModelKind("video"), "video");
  assert.equal(normalizeModelKind("embedding"), "embedding");
  // Audio-shaped upstream types collapse into one bucket.
  assert.equal(normalizeModelKind("tts"), "audio");
  assert.equal(normalizeModelKind("stt"), "audio");
  // Unknown/missing is treated as chat, matching discovery's own assumption.
  assert.equal(normalizeModelKind("something-else"), "llm");
  assert.equal(normalizeModelKind(undefined), "llm");
});

test("kind filters are normalized, deduped and case-insensitive", () => {
  // The filter stores kind IDs ("llm"), not the UI labels ("Chat"). Unknown
  // values — including a label sent by mistake — are dropped, never persisted.
  assert.deepEqual(normalizeAutoAddKinds(["llm", "LLM", "IMAGE"]), ["llm", "image"]);
  // Unknown values are dropped rather than persisted as a dead filter.
  assert.deepEqual(normalizeAutoAddKinds(["llm", "banana", 42, null]), ["llm"]);
  assert.deepEqual(normalizeAutoAddKinds("not-an-array"), []);
  assert.deepEqual(normalizeAutoAddKinds(undefined), []);
});

test("sync settings round-trip the kind filter and default to no filter", () => {
  assert.deepEqual(DEFAULT_SYNC_SETTINGS.autoAddKinds, []);
  const stored = normalizeSyncSettings({ autoAdd: true, autoAddKinds: ["image"] });
  assert.deepEqual(stored.autoAddKinds, ["image"]);
  // Re-reading a stored record is idempotent (normalization is not cumulative).
  assert.deepEqual(normalizeSyncSettings(stored).autoAddKinds, ["image"]);
  // A record written before the filter existed gains an empty filter = no filter,
  // never a filter that would exclude everything.
  assert.deepEqual(normalizeSyncSettings({ autoAdd: true }).autoAddKinds, []);
  // Corrupt stored values degrade to no filter, not to an exclusion.
  assert.deepEqual(normalizeSyncSettings({ autoAddKinds: "oops" }).autoAddKinds, []);
  assert.deepEqual(normalizeSyncSettings({ autoAddKinds: ["nope"] }).autoAddKinds, []);
});

test("an empty kind filter leaves every policy outcome unchanged", () => {
  const rows = [row("gpt-4o", "llm"), row("imagen", "image"), row("tts-1", "tts")];
  const results = { "alias/gpt-4o": "ok", "alias/imagen": "ok", "alias/tts-1": "ok" };
  const { toAdd, toDisable } = resolveAutoAdd({
    discoveredRows: rows,
    testResults: results,
    disabledIds: [],
    policy: "all",
    autoAddKinds: [],
  });
  assert.deepEqual(toAdd.sort(), ["gpt-4o", "imagen", "tts-1"]);
  assert.deepEqual(toDisable, []);
});

test("a kind filter restricts auto-add to the selected kinds", () => {
  const rows = [row("gpt-4o", "llm"), row("imagen", "image"), row("tts-1", "tts")];
  const results = { "alias/gpt-4o": "ok", "alias/imagen": "ok", "alias/tts-1": "ok" };
  const { toAdd } = resolveAutoAdd({
    discoveredRows: rows,
    testResults: results,
    disabledIds: [],
    policy: "all",
    autoAddKinds: ["llm", "audio"],
  });
  assert.deepEqual(toAdd.sort(), ["gpt-4o", "tts-1"]);
});

test("a filtered-out kind is never pushed to the disabled list", () => {
  // The regression this guards: with a failing image model and a chat-only
  // filter, the image model must be left completely untouched — not added,
  // and NOT disabled (which would hide a model the filter never mentioned).
  const rows = [row("gpt-4o", "llm"), row("broken-image", "image")];
  const results = { "alias/gpt-4o": "ok", "alias/broken-image": "error" };
  const { toAdd, toDisable } = resolveAutoAdd({
    discoveredRows: rows,
    testResults: results,
    disabledIds: [],
    policy: "working-disable-failed",
    autoAddKinds: ["llm"],
  });
  assert.deepEqual(toAdd, ["gpt-4o"]);
  assert.deepEqual(toDisable, []);
});

test("a failing model inside the selected kinds is still disabled", () => {
  // The counterpart: the filter must not weaken the policy for kinds it allows.
  const rows = [row("gpt-4o", "llm"), row("broken-llm", "llm")];
  const results = { "alias/gpt-4o": "ok", "alias/broken-llm": "error" };
  const { toAdd, toDisable } = resolveAutoAdd({
    discoveredRows: rows,
    testResults: results,
    disabledIds: [],
    policy: "working-disable-failed",
    autoAddKinds: ["llm"],
  });
  assert.deepEqual(toAdd, ["gpt-4o"]);
  assert.deepEqual(toDisable, ["broken-llm"]);
});

test("the kind filter never re-enables or duplicates an existing model", () => {
  const rows = [row("already-added", "llm", { isAdded: true }), row("fresh", "llm")];
  const { toAdd, toDisable } = resolveAutoAdd({
    discoveredRows: rows,
    testResults: { "alias/already-added": "ok", "alias/fresh": "ok" },
    disabledIds: ["gpt-hidden"],
    policy: "working-disable-failed",
    autoAddKinds: ["llm"],
  });
  assert.deepEqual(toAdd, ["fresh"]);
  assert.deepEqual(toDisable, []);
});

test("a garbage kind filter is ignored instead of excluding everything", () => {
  const rows = [row("gpt-4o", "llm")];
  const { toAdd } = resolveAutoAdd({
    discoveredRows: rows,
    testResults: { "alias/gpt-4o": "ok" },
    disabledIds: [],
    policy: "working-only",
    autoAddKinds: ["banana"],
  });
  // Normalization drops the unknown kind, leaving an empty (= no) filter.
  assert.deepEqual(toAdd, ["gpt-4o"]);
});
