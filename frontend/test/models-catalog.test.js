/**
 * Tests for the global Models page catalog assembly.
 *
 * Two regressions are covered here:
 *  1. noAuth providers (opencode, local-device, local TTS engines, searxng)
 *     were hidden by the default "connected" filter because they have no
 *     connections by design — the page rendered "0/0 active".
 *  2. Provider-sync discovered models were never read by the Models page at
 *     all, so dynamically discovered models were missing from the global
 *     catalog even though the provider page displayed them.
 *
 * buildEntries mirrors the dedupe/filter rules in pages/models/page.jsx.
 */
import test from "node:test";
import assert from "node:assert/strict";

const STATIC = {
  oc: ["big-pickle", "mimo-v2.5-free", "ling-3.0-flash-fin-free", "nemotron-3-ultra-free",
       "nemotron-3.5-lightning-free", "muse-spark-1.3-contributor-free", "muse-spark-1.2-contributor-free"],
  openrouter: ["anthropic/claude-opus-4.7"],
};
const ALIAS_OF = { opencode: "oc", openrouter: "openrouter", "local-device": "local-device" };
const ID_BY_ALIAS = { oc: "opencode", openrouter: "openrouter", "local-device": "local-device" };
const NOAUTH = new Set(["opencode", "local-device", "google-tts", "edge-tts", "coqui", "tortoise", "searxng"]);

function buildEntries({ connections = [], providerIds, customModels = [], syncedModels = [],
                        modelAliases = {}, disabledMap = {}, providerFilter = "connected" } = {}) {
  const connectedProviders = new Set(connections.filter((c) => c.isActive !== false).map((c) => c.provider));
  for (const id of NOAUTH) connectedProviders.add(id); // noAuth counts as connected

  const out = [];
  const ids = providerFilter === "all" ? providerIds
    : providerFilter === "connected" ? providerIds.filter((id) => connectedProviders.has(id))
    : [providerFilter];

  const hardcodedByAlias = {};
  for (const pid of providerIds) {
    const a = ALIAS_OF[pid];
    if (STATIC[a]) hardcodedByAlias[a] = new Set(STATIC[a]);
  }
  const customKeys = new Set(customModels.map((m) => `${m.providerAlias}/${m.id}`));
  const hiddenByAlias = (a) => new Set(disabledMap[a] || []);

  for (const providerId of ids) {
    const alias = ALIAS_OF[providerId];
    for (const id of STATIC[alias] || []) {
      out.push({ key: `${alias}/${id}`, providerAlias: alias, id, fullModel: `${alias}/${id}` });
    }
  }

  const syncedIds = new Set();
  for (const m of syncedModels) {
    const storageAlias = m.storageAlias || m.providerAlias;
    if (!storageAlias || !m.id) continue;
    const fullModel = m.fullModel || `${storageAlias}/${m.id}`;
    if (providerFilter !== "all" && providerFilter !== "connected") {
      if (storageAlias !== ALIAS_OF[providerFilter]) continue;
    }
    if (providerFilter === "connected" && !connectedProviders.has(ID_BY_ALIAS[storageAlias])) continue;
    if (hardcodedByAlias[storageAlias]?.has(m.id)) continue;
    if (customKeys.has(`${storageAlias}/${m.id}`)) continue;
    syncedIds.add(fullModel);
    out.push({ key: fullModel, providerAlias: storageAlias, id: m.id, fullModel });
  }

  for (const m of customModels) {
    if (providerFilter === "connected" && ![...connectedProviders].some((id) => ALIAS_OF[id] === m.providerAlias)) continue;
    out.push({ key: `${m.providerAlias}/${m.id}`, providerAlias: m.providerAlias, id: m.id, fullModel: `${m.providerAlias}/${m.id}` });
  }

  for (const [aliasName, fullModel] of Object.entries(modelAliases)) {
    if (typeof fullModel !== "string" || !fullModel.includes("/")) continue;
    const slash = fullModel.indexOf("/");
    const storageAlias = fullModel.slice(0, slash);
    const modelId = fullModel.slice(slash + 1);
    if (!modelId) continue;
    if (hardcodedByAlias[storageAlias]?.has(modelId)) continue;
    if (syncedIds.has(`${storageAlias}/${modelId}`)) continue;
    if (providerFilter === "connected" && !connectedProviders.has(ID_BY_ALIAS[storageAlias])) continue;
    out.push({ key: fullModel, providerAlias: storageAlias, id: modelId, fullModel, name: aliasName });
  }
  return out;
}

const PROVIDER_IDS = ["opencode", "openrouter", "local-device"];

test("noAuth provider models appear with zero connections (was 0/0 active)", () => {
  const entries = buildEntries({ providerIds: PROVIDER_IDS });
  assert.ok(entries.length > 0, "models must not be empty with no connections");
  assert.ok(entries.some((e) => e.providerAlias === "oc"), "opencode models must be listed");
  assert.equal(entries.filter((e) => e.providerAlias === "oc").length, 7, "7 static oc models");
});

test("synced discovered models are registered in the global catalog", () => {
  const entries = buildEntries({
    providerIds: PROVIDER_IDS,
    syncedModels: [{ id: "space-bunny-free", storageAlias: "oc", fullModel: "oc/space-bunny-free" }],
  });
  const found = entries.find((e) => e.fullModel === "oc/space-bunny-free");
  assert.ok(found, "synced model must appear");
  assert.equal(found.id, "space-bunny-free", "exact upstream id preserved");
  assert.equal(found.providerAlias, "oc", "provider alias preserved");
});

test("a model present in both synced catalog and static list appears once", () => {
  const entries = buildEntries({
    providerIds: PROVIDER_IDS,
    syncedModels: [{ id: "big-pickle", storageAlias: "oc", fullModel: "oc/big-pickle" }],
  });
  const dupes = entries.filter((e) => e.fullModel === "oc/big-pickle");
  assert.equal(dupes.length, 1, `expected 1 entry, got ${dupes.length}`);
});

test("a model in both the synced catalog and an alias appears once", () => {
  const entries = buildEntries({
    providerIds: PROVIDER_IDS,
    syncedModels: [{ id: "mimo-v2.6-flash-free", storageAlias: "oc", fullModel: "oc/mimo-v2.6-flash-free" }],
    modelAliases: { "mimo-v2.6-flash-free": "oc/mimo-v2.6-flash-free" },
  });
  const dupes = entries.filter((e) => e.fullModel === "oc/mimo-v2.6-flash-free");
  assert.equal(dupes.length, 1, `expected 1 entry, got ${dupes.length}`);
});

test("models of different providers with the same id are not merged", () => {
  const entries = buildEntries({
    providerIds: PROVIDER_IDS,
    providerFilter: "all",
    syncedModels: [
      { id: "shared-name", storageAlias: "oc", fullModel: "oc/shared-name" },
      { id: "shared-name", storageAlias: "openrouter", fullModel: "openrouter/shared-name" },
    ],
  });
  assert.equal(entries.filter((e) => e.id === "shared-name").length, 2,
    "same model id under two providers must remain two records");
});

test("provider filter still isolates a specific provider", () => {
  const entries = buildEntries({
    providerIds: PROVIDER_IDS,
    providerFilter: "opencode",
    syncedModels: [{ id: "space-bunny-free", storageAlias: "oc", fullModel: "oc/space-bunny-free" }],
  });
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.providerAlias === "oc"), "only opencode models");
});
