// Provider-page built-in model catalogue — regression guard.
//
// BUG: the provider detail page rendered ZERO built-in models. The shared
// Available Models section scopes itself to one provider by storage alias, and
// it passed an EMPTY provider list. `buildModelEntries` uses
// `providerIds || Object.keys(AI_PROVIDERS)`, and `[]` is truthy — so the
// static-catalogue loop iterated over nothing and emitted no built-ins. Only
// synced and manually added models appeared, which made it look as though the
// code-defined catalogue had been deleted.
//
// The global Models page was unaffected (it passes the real list), which is why
// the same models were visible there and invisible on the provider page.
import { test } from "node:test";
import assert from "node:assert/strict";

import { getModelsByProviderId } from "@/shared/constants/models";
import { AI_PROVIDERS, getProviderAlias } from "@/shared/constants/providers";
import {
  buildModelEntries,
  providerIdsForAlias,
} from "@/shared/utils/modelCatalog";

const ALL_PROVIDER_IDS = Object.keys(AI_PROVIDERS);

// Mirrors exactly what AvailableModelsSection does when scoped to a provider.
function providerPageEntries(providerId, extra = {}) {
  const alias = getProviderAlias(providerId);
  return buildModelEntries({
    connections: [{ provider: providerId, isActive: true }],
    customModels: [],
    syncedModels: [],
    modelAliases: {},
    disabledMap: {},
    providerFilter: "all",
    providerIds: providerIdsForAlias(alias, ALL_PROVIDER_IDS),
    ...extra,
  }).filter((e) => e.providerAlias === alias);
}

test("a provider page shows every built-in model of its provider", () => {
  // The specific regression: antigravity's 12 models were invisible.
  const shown = providerPageEntries("antigravity");
  const builtIn = getModelsByProviderId("antigravity") || [];
  const uniqueIds = new Set(builtIn.map((m) => m.id));

  assert.ok(builtIn.length > 0, "antigravity must have a built-in catalogue");
  assert.equal(shown.length, uniqueIds.size);

  const shownIds = new Set(shown.map((e) => e.id));
  for (const id of uniqueIds) {
    assert.ok(shownIds.has(id), `antigravity/${id} missing from the provider page`);
  }
});

test("every provider with a built-in catalogue shows it on its own page", () => {
  // The bug was not antigravity-specific: every provider page was affected.
  const failures = [];
  for (const providerId of ALL_PROVIDER_IDS) {
    const builtIn = getModelsByProviderId(providerId) || [];
    if (builtIn.length === 0) continue;
    const unique = new Set(builtIn.map((m) => m.id)).size;
    const shown = providerPageEntries(providerId).length;
    if (shown !== unique) {
      failures.push(`${providerId}: expected ${unique}, rendered ${shown}`);
    }
  }
  assert.deepEqual(failures, [], `provider pages missing built-in models:\n${failures.join("\n")}`);
});

test("a provider page and the global Models page agree on built-ins", () => {
  // Both read the same catalogue, so a model must not exist in one and be
  // absent from the other.
  const forProvider = (providerId) => {
    const global = buildModelEntries({
      connections: [{ provider: providerId, isActive: true }],
      providerFilter: "connected",
      providerIds: ALL_PROVIDER_IDS,
      noAuthProviderIds: new Set(),
    });
    const alias = getProviderAlias(providerId);
    return new Set(global.filter((e) => e.providerAlias === alias).map((e) => e.id));
  };
  for (const providerId of ["antigravity", "openai", "gemini", "codex", "opencode"]) {
    const page = new Set(providerPageEntries(providerId).map((e) => e.id));
    const global = forProvider(providerId);
    assert.deepEqual([...page].sort(), [...global].sort(), `${providerId} disagrees between pages`);
  }
});

test("built-in models are marked BUILT-IN, not custom or synced", () => {
  // The distinction the UI relies on to label cards.
  const entry = providerPageEntries("antigravity").find((e) => e.id === "gemini-3-flash-agent");
  assert.ok(entry, "expected gemini-3-flash-agent");
  assert.equal(entry.isCustom, false);
  assert.equal(entry.isSynced, false);
  assert.equal(entry.fullModel, "ag/gemini-3-flash-agent");
  assert.equal(entry.providerAlias, "ag");
});

test("manually added and synced models still merge into the provider page", () => {
  // The fix must not cost the other model sources.
  const entries = providerPageEntries("antigravity", {
    modelAliases: { "my-custom": "ag/my-custom" },
    syncedModels: [{ storageAlias: "ag", id: "discovered-1", name: "Discovered" }],
  });
  const ids = entries.map((e) => e.id);
  assert.ok(ids.includes("gemini-3-flash-agent"), "built-in still present");
  assert.ok(ids.includes("my-custom"), "manual alias still present");
  assert.ok(ids.includes("discovered-1"), "synced model still present");
});

test("a synced model matching a built-in id does not duplicate the card", () => {
  // Sync must not create a second card for a model already in the catalogue.
  const entries = providerPageEntries("antigravity", {
    syncedModels: [{ storageAlias: "ag", id: "gemini-3-flash-agent", name: "Sync copy" }],
  });
  const matches = entries.filter((e) => e.id === "gemini-3-flash-agent");
  assert.equal(matches.length, 1, "expected exactly one card");
  // The built-in entry wins, so the richer static name is kept.
  assert.equal(matches[0].isSynced, false);
  assert.equal(matches[0].name, "Gemini 3.5 Flash (High)");
});

test("a compatible node resolves to no built-in ids, so it renders synced models only", () => {
  // A custom node is not in AI_PROVIDERS and has no static catalogue; passing
  // an empty list here is correct for it, unlike for a real provider.
  const nodeId = "openai-compatible-chat-00000000-0000-0000-0000-000000000000";
  assert.deepEqual(providerIdsForAlias(nodeId, ALL_PROVIDER_IDS), []);
  const entries = buildModelEntries({
    connections: [{ provider: nodeId, isActive: true }],
    modelAliases: { "node-model": `${nodeId}/node-model` },
    syncedModels: [{ storageAlias: nodeId, id: "synced-1" }],
    providerFilter: "all",
    providerIds: providerIdsForAlias(nodeId, ALL_PROVIDER_IDS),
  }).filter((e) => e.providerAlias === nodeId);
  const ids = entries.map((e) => e.id).sort();
  assert.deepEqual(ids, ["node-model", "synced-1"]);
});

test("providerIdsForAlias resolves ids, and never an empty list for a real provider", () => {
  assert.deepEqual(providerIdsForAlias("ag", ALL_PROVIDER_IDS), ["antigravity"]);
  // OpenCode's alias is "oc" and its id is "opencode".
  assert.deepEqual(providerIdsForAlias("oc", ALL_PROVIDER_IDS), ["opencode"]);
  // An unknown alias (a compatible node id) has no static catalogue.
  assert.deepEqual(providerIdsForAlias("nope", ALL_PROVIDER_IDS), []);
  assert.deepEqual(providerIdsForAlias("", ALL_PROVIDER_IDS), []);
  assert.deepEqual(providerIdsForAlias(null, ALL_PROVIDER_IDS), []);
});

test("hidden state is preserved for built-in models on the provider page", () => {
  // A user-disabled model must stay disabled; restoring the catalogue must not
  // re-enable anything.
  const entries = providerPageEntries("antigravity", {
    disabledMap: { ag: ["gemini-3-flash-agent"] },
  });
  const target = entries.find((e) => e.id === "gemini-3-flash-agent");
  assert.ok(target, "hidden models still render, flagged as hidden");
  assert.equal(target.hidden, true);
  const other = entries.find((e) => e.id === "claude-sonnet-4-6");
  assert.equal(other.hidden, false);
});
