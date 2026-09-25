/**
 * Tests for the "Test all (N)" candidate list on the provider detail page.
 *
 * Regression: ModelBatchTest was only handed `customModels` (alias-registered
 * models), so a provider displaying built-in + discovered models reported
 * "Test all (2)" while showing far more. The count must equal the models
 * actually rendered as enabled chips, with no duplicates.
 */
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Mirrors the assembly in pages/providers/[id]/page.jsx.
 * @param {object} o
 * @returns {Array} testable models
 */
function buildTestable({ staticModels = [], syncedModels = [], modelAliases = {},
                        storageAlias = "oc", passthrough = true, disabledIds = [] } = {}) {
  const disabled = new Set(disabledIds);

  const discovered = syncedModels
    .filter((m) => (m.storageAlias || m.providerAlias) === storageAlias)
    .map((m) => ({ id: m.id, name: m.name || m.id, type: m.type || "llm", isFree: !!m.isFree }));

  const allModels = [
    ...staticModels,
    ...discovered.filter((dm) => !staticModels.some((m) => m.id === dm.id)),
  ];

  const displayModels = allModels.filter((m) => !disabled.has(m.id));

  const customModels = Object.entries(modelAliases)
    .filter(([alias, fullModel]) => {
      if (!fullModel.startsWith(`${storageAlias}/`)) return false;
      const id = fullModel.slice(storageAlias.length + 1);
      if (allModels.some((m) => m.id === id)) return false;
      if (passthrough) return true;
      return alias === id;
    })
    .map(([, fullModel]) => ({ id: fullModel.slice(storageAlias.length + 1), fullModel }));

  return [
    ...displayModels.map((m) => ({ id: m.id, fullModel: `${storageAlias}/${m.id}`, isFree: !!m.isFree })),
    ...customModels.map((m) => ({ id: m.id, fullModel: `${storageAlias}/${m.id}`, isFree: false })),
  ];
}

const STATIC = [
  { id: "big-pickle" }, { id: "mimo-v2.5-free" }, { id: "ling-3.0-flash-fin-free" },
  { id: "nemotron-3-ultra-free" }, { id: "nemotron-3.5-lightning-free" },
  { id: "muse-spark-1.3-contributor-free" }, { id: "muse-spark-1.2-contributor-free" },
];
const SYNCED = [
  { id: "mimo-v2.6-flash-free", storageAlias: "oc" },
  { id: "space-bunny-free", storageAlias: "oc" },
];
const ALIASES = { "space-bunny-free": "oc/space-bunny-free", "mimo-v2.6-flash-free": "oc/mimo-v2.6-flash-free" };

test("Test all covers every displayed model, not just alias/custom ones", () => {
  const models = buildTestable({ staticModels: STATIC, syncedModels: SYNCED, modelAliases: ALIASES });
  assert.equal(models.length, 9, `expected 9, got ${models.length}`);
});

test("no duplicate entries when a model is both synced and aliased", () => {
  const models = buildTestable({ staticModels: STATIC, syncedModels: SYNCED, modelAliases: ALIASES });
  const ids = models.map((m) => m.id);
  assert.equal(ids.length, new Set(ids).size, "no duplicates");
  assert.equal(models.filter((m) => m.id === "space-bunny-free").length, 1);
});

test("every tested model is addressed by the exact provider/model id", () => {
  const models = buildTestable({ staticModels: STATIC, syncedModels: SYNCED, modelAliases: ALIASES });
  for (const m of models) {
    assert.equal(m.fullModel, `oc/${m.id}`, `bad fullModel for ${m.id}`);
  }
  assert.ok(models.some((m) => m.id === "space-bunny-free"));
  assert.ok(models.some((m) => m.id === "mimo-v2.6-flash-free"));
});

test("disabled models are excluded from the Test all scope", () => {
  const models = buildTestable({
    staticModels: STATIC, syncedModels: SYNCED, modelAliases: ALIASES,
    disabledIds: ["big-pickle", "space-bunny-free"],
  });
  assert.equal(models.length, 7, `expected 7 after disabling 2, got ${models.length}`);
  assert.ok(!models.some((m) => m.id === "big-pickle"));
  assert.ok(!models.some((m) => m.id === "space-bunny-free"));
});

test("static-only provider still counts every built-in model", () => {
  const models = buildTestable({ staticModels: STATIC, modelAliases: {} });
  assert.equal(models.length, STATIC.length);
});
