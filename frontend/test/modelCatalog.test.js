// Shared model catalog builder.
//
// This is the one implementation behind BOTH the global Models page and every
// provider page, so its dedupe and identity rules are load-bearing: a mistake
// here renders the same model twice on two different pages.
import { test } from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "@/shared/constants/models";
import {
  buildModelEntries,
  buildProviderOptions,
  mapBareTestResults,
  mapPersistedTestResults,
} from "../src/shared/utils/modelCatalog.js";

const NO_AUTH = new Set();
const base = {
  providerIds: [],
  noAuthProviderIds: NO_AUTH,
  connections: [],
  customModels: [],
  syncedModels: [],
  modelAliases: {},
  disabledMap: {},
  providerFilter: "all",
};

const idsOf = (entries) => entries.map((e) => e.fullModel).sort();

test("empty inputs produce no entries", () => {
  assert.deepEqual(buildModelEntries({ ...base }), []);
});

test("aliases become addressable entries keyed alias/model", () => {
  const entries = buildModelEntries({
    ...base,
    modelAliases: { "gpt-4o": "oc/gpt-4o" },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fullModel, "oc/gpt-4o");
  assert.equal(entries[0].id, "gpt-4o");
  assert.equal(entries[0].name, "gpt-4o");
});

test("a synced model and an alias for the same model render once", () => {
  // The duplicate-prevention case: a model that was synced AND then added via
  // Add Model exists in two stores, and must produce exactly one card.
  const entries = buildModelEntries({
    ...base,
    syncedModels: [{ storageAlias: "oc", id: "gpt-4o", name: "GPT-4o" }],
    modelAliases: { "gpt-4o": "oc/gpt-4o" },
  });
  assert.deepEqual(idsOf(entries), ["oc/gpt-4o"]);
  // The synced record carries the richer metadata and must win.
  assert.equal(entries[0].isSynced, true);
  assert.equal(entries[0].name, "GPT-4o");
});

test("stale synced entries are never offered", () => {
  const entries = buildModelEntries({
    ...base,
    syncedModels: [{ storageAlias: "oc", id: "gone", stale: true }],
  });
  assert.deepEqual(entries, []);
});

test("custom models and aliases for the same id render once", () => {
  const entries = buildModelEntries({
    ...base,
    customModels: [{ providerAlias: "oc", id: "my-model", name: "Mine" }],
    modelAliases: { "my-model": "oc/my-model" },
  });
  assert.deepEqual(idsOf(entries), ["oc/my-model"]);
  assert.equal(entries.length, 1);
});

test("two providers exposing the same model id do not collide", () => {
  const entries = buildModelEntries({
    ...base,
    syncedModels: [
      { storageAlias: "oc", id: "shared" },
      { storageAlias: "pplx", id: "shared" },
    ],
  });
  assert.deepEqual(idsOf(entries), ["oc/shared", "pplx/shared"]);
});

test("an alias name is owned by exactly one model", () => {
  // The alias store is a flat { aliasName: fullModel } map, so a short label
  // can only ever point at one model. Two providers exposing the same model id
  // must therefore keep DISTINCT alias names, and both stay addressable by
  // their full provider-qualified model.
  const entries = buildModelEntries({
    ...base,
    modelAliases: { "qwen3.5-plus": "oc/qwen3.5-plus", "pplx-qwen": "pplx/qwen3.5-plus" },
  });
  assert.deepEqual(idsOf(entries), ["oc/qwen3.5-plus", "pplx/qwen3.5-plus"]);
  // Display names are unique, so a card is never ambiguous.
  const names = entries.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
});

test("a model id shared by two providers keeps both entries distinct", () => {
  const entries = buildModelEntries({
    ...base,
    syncedModels: [
      { storageAlias: "oc", id: "shared", name: "Shared" },
      { storageAlias: "pplx", id: "shared", name: "Shared" },
    ],
    modelAliases: { ocShared: "oc/shared", pplxShared: "pplx/shared" },
  });
  // Synced records claim the key first; the alias entries are then deduped out.
  assert.deepEqual(idsOf(entries), ["oc/shared", "pplx/shared"]);
  assert.equal(entries.every((e) => e.isSynced), true);
});

test("model ids containing slashes keep their full identity", () => {
  const entries = buildModelEntries({
    ...base,
    modelAliases: { "claude": "openrouter/anthropic/claude-3" },
  });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].fullModel, "openrouter/anthropic/claude-3");
  // Only the FIRST slash is the alias boundary, so the id is preserved intact.
  assert.equal(entries[0].id, "anthropic/claude-3");
});

test("hidden models are flagged from the disabled map, keyed by alias", () => {
  const entries = buildModelEntries({
    ...base,
    modelAliases: { a: "oc/a", b: "oc/b" },
    disabledMap: { oc: ["a"] },
  });
  const byId = Object.fromEntries(entries.map((e) => [e.id, e.hidden]));
  assert.equal(byId.a, true);
  assert.equal(byId.b, false);
});

test("scoping to one storage alias returns only that provider's models", () => {
  const entries = buildModelEntries({
    ...base,
    modelAliases: { a: "oc/a", b: "pplx/b" },
    providerFilter: "__scoped__",
  });
  // __scoped__ is not a provider id, so nothing is admitted by the candidate
  // set; the provider page filters this list itself by alias.
  assert.deepEqual(entries, []);
  const scoped = buildModelEntries({
    ...base,
    modelAliases: { a: "oc/a", b: "pplx/b" },
  }).filter((e) => e.providerAlias === "oc");
  assert.deepEqual(idsOf(scoped), ["oc/a"]);
});

test("provider option counts add synced, custom and alias models to the built-ins", () => {
  // Counting only the static catalogue is the bug this guards: it hid OpenCode
  // (and any synced/custom provider) from the provider filter entirely.
  const options = buildProviderOptions({
    providerIds: ["openai", "groq"],
    connectedProviders: new Set(["openai"]),
    syncedModels: [{ storageAlias: "openai", id: "s1" }],
    customModels: [{ providerAlias: "groq", id: "c1" }],
    modelAliases: { g: "groq/g1" },
  });
  const byId = Object.fromEntries(options.map((o) => [o.id, o]));
  const staticOpenai = getModelsByProviderId("openai").length;
  const staticGroq = getModelsByProviderId("groq").length;
  assert.equal(byId.openai.count, staticOpenai + 1); // + synced
  assert.equal(byId.groq.count, staticGroq + 2); // + custom + alias
  assert.equal(byId.openai.connected, true);
  assert.equal(byId.groq.connected, false);
});

test("a provider with no static models still appears once models are added", () => {
  // A provider can be absent from the static catalogue entirely. Counting only
  // static models hid it from the provider filter even when the user had
  // synced, custom or alias models registered under it.
  const target = "sdwebui";
  const staticCount = getModelsByProviderId(target).length;
  const connected = new Set([target]);
  const before = buildProviderOptions({ providerIds: [target], connectedProviders: connected });
  const after = buildProviderOptions({
    providerIds: [target],
    connectedProviders: connected,
    syncedModels: [{ storageAlias: "sdwebui", id: "extra" }],
    customModels: [{ providerAlias: "sdwebui", id: "c1" }],
    modelAliases: { "sdwebui-alias": "sdwebui/a1" },
  });
  const countOf = (list) => list.find((o) => o.id === target)?.count ?? 0;
  assert.equal(countOf(after), staticCount + 3);
  assert.ok(countOf(after) > countOf(before));
});

test("providers with no models at all are omitted from the options", () => {
  // tavily is a search provider: no models, so it must not appear.
  assert.equal(getModelsByProviderId("tavily").length, 0);
  const options = buildProviderOptions({
    providerIds: ["tavily"],
    connectedProviders: new Set(["tavily"]),
  });
  assert.deepEqual(options, []);
});

test("persisted test records map to ok/error, ignoring other states", () => {
  const mapped = mapPersistedTestResults({
    "oc/a": { status: "passed" },
    "oc/b": { status: "failed" },
    "oc/c": { status: "timeout" },
    "oc/d": { status: "testing" },
  });
  assert.deepEqual(mapped, { "oc/a": "ok", "oc/b": "error", "oc/c": "error" });
});

test("bare-id results strip only the storage alias prefix", () => {
  // Model ids may contain slashes, so stripping must be prefix-anchored and
  // must not touch a record belonging to another provider.
  const mapped = mapBareTestResults(
    {
      "oc/gpt-4o": { status: "passed" },
      "oc/anthropic/claude-3": { status: "failed" },
      "pplx/gpt-4o": { status: "passed" },
      "gpt-4o": { status: "passed" },
    },
    "oc"
  );
  assert.deepEqual(mapped, {
    "gpt-4o": "ok",
    "anthropic/claude-3": "error",
  });
});
