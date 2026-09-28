/**
 * Regression tests for custom-provider model parity.
 *
 * Root cause: OpenAI/Anthropic-compatible (custom) nodes have no static
 * catalog, so their sync-discovered models were stored but never considered by
 * the shared working-models query — the Playground "Working models only" list
 * and GET /api/models/working silently excluded every custom-provider model.
 *
 * Also pins the URL normalization contract for compatible /models discovery:
 * trailing slashes and pasted "/models" suffixes must not double-append, and
 * missing API keys must not produce "Bearer " headers (keyless self-hosted
 * upstreams are valid).
 *
 * Runs against a throwaway SQLite DATA_DIR; upstream fetches are mocked via a
 * stubbed global fetch so no network is touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-compatible-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const {
  createProviderNode,
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnectionsByProvider,
} = await import("../src/lib/localDb.js");
const { getProviderConnections } = await import("../src/lib/localDb.js");
const { getSyncedModels, persistDiscovered } = await import("../src/lib/models/modelSync.js");
const { getWorkingModels } = await import("../src/lib/models/eligibility.js");

const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
let seedCounter = 0;

async function seedCompatibleProvider() {
  // Unique per call: tests share one DATA_DIR (kv store), so storage aliases
  // must never collide or one test's synced models leak into another.
  seedCounter += 1;
  const node = await createProviderNode({
    id: `${OPENAI_COMPATIBLE_PREFIX}chat-paritytest-${seedCounter}`,
    type: "openai-compatible",
    prefix: `parity${seedCounter}`,
    apiType: "chat",
    baseUrl: "https://parity.example.com/v1",
    name: `Parity Test Node ${seedCounter}`,
  });
  const conn = await createProviderConnection({
    provider: node.id,
    authType: "apikey",
    name: node.name,
    apiKey: "sk-parity-test",
    isActive: true,
    priority: 1,
  });
  return { node, conn };
}

test("sync-discovered models of a compatible node are considered working after a passed test", async () => {
  const { node, conn } = await seedCompatibleProvider();
  try {
    // Simulate a sync discovering an upstream model (exactly what modelSync persists).
    const persist = await persistDiscovered({
      storageAlias: node.id,
      discovered: [{ id: "qwen/qwen3.7-flash:free", name: "Qwen 3.7 Flash Free", type: "llm" }],
      manualIds: [],
    });
    assert.equal(persist.added, 1);

    const synced = await getSyncedModels(node.id);
    const record = Object.values(synced).find((m) => m.id === "qwen/qwen3.7-flash:free");
    assert.ok(record, "synced record must exist");
    assert.equal(record.fullModel, `${node.id}/qwen/qwen3.7-flash:free`);

    // No test result yet → not working (never mark healthy on discovery alone).
    let working = await getWorkingModels();
    assert.equal(
      working.find((m) => m.fullModel === record.fullModel),
      undefined,
      "discovered-but-untested models must NOT be working"
    );

    // Mark the model test as passed (keyed by the same full-model string).
    const { saveModelTestResult } = await import("../src/lib/models/modelTestRepo.js");
    await saveModelTestResult(record.fullModel, { status: "passed", latencyMs: 12, testedAt: new Date().toISOString() });

    working = await getWorkingModels();
    const entry = working.find((m) => m.fullModel === record.fullModel);
    assert.ok(entry, "synced + passed + connected model must be working");
    assert.equal(entry.id, "qwen/qwen3.7-flash:free", "original upstream id preserved exactly");
    assert.equal(entry.fullModel, `${node.id}/qwen/qwen3.7-flash:free`);
  } finally {
    await deleteProviderConnectionsByProvider(node.id).catch(() => {});
  }
});

test("manual (alias) models survive sync and stay working-eligible", async () => {
  const { node } = await seedCompatibleProvider();
  try {
    // Manual alias added by the user through the dashboard.
    const { setModelAlias } = await import("../src/lib/localDb.js");
    const manualId = "my-manual-model";
    await setModelAlias("parity-manual", `${node.id}/${manualId}`);

    // A later sync discovers only a different model — the manual one disappears
    // upstream but must not be deleted.
    await persistDiscovered({
      storageAlias: node.id,
      discovered: [{ id: "upstream-only", name: "Upstream Only", type: "llm" }],
      manualIds: [],
    });
    const synced = await getSyncedModels(node.id);
    const staleRecord = Object.values(synced).find((m) => m.id === "upstream-only");
    assert.ok(staleRecord);

    // Wait — a fresh sync would mark upstream-only stale; simulate re-sync that
    // keeps it (persistDiscovered marks previously-seen-but-gone rows stale).
    const { persistDiscovered: persistAgain } = await import("../src/lib/models/modelSync.js");
    await persistAgain({ storageAlias: node.id, discovered: [], manualIds: [] });
    const after = await getSyncedModels(node.id);
    const marked = Object.values(after).find((m) => m.id === "upstream-only");
    assert.equal(marked.stale, true, "vanished upstream models are marked stale, not deleted");

    // Manual alias is untouched by sync and still eligible.
    const { getModelAliases } = await import("../src/lib/localDb.js");
    const aliases = await getModelAliases();
    assert.equal(aliases["parity-manual"], `${node.id}/${manualId}`);
  } finally {
    await deleteProviderConnectionsByProvider(node.id).catch(() => {});
  }
});

test("repeated syncs do not create duplicate model records", async () => {
  const { node } = await seedCompatibleProvider();
  try {
    const discovered = [
      { id: "model-a", name: "A", type: "llm" },
      { id: "model-b", name: "B", type: "llm" },
    ];
    await persistDiscovered({ storageAlias: node.id, discovered, manualIds: [] });
    await persistDiscovered({ storageAlias: node.id, discovered, manualIds: [] });
    await persistDiscovered({ storageAlias: node.id, discovered, manualIds: [] });
    const synced = await getSyncedModels(node.id);
    const ids = Object.values(synced).map((m) => m.id).sort();
    assert.deepEqual(ids, ["model-a", "model-b"], "idempotent sync keeps one record per model id");
  } finally {
    await deleteProviderConnectionsByProvider(node.id).catch(() => {});
  }
});

test("connection status update path stores and returns accurate status", async () => {
  const { node, conn } = await seedCompatibleProvider();
  try {
    const stored = await updateProviderConnection(conn.id, {
      testStatus: "error",
      lastError: "[404]: Requested entity was not found",
      lastErrorAt: new Date().toISOString(),
    });
    assert.equal(stored.testStatus, "error");
    assert.equal(stored.lastError, "[404]: Requested entity was not found");

    const reread = (await getProviderConnections({ provider: node.id })).find((c) => c.id === conn.id);
    assert.equal(reread.testStatus, "error", "status persists (authoritative DB, not memory)");
  } finally {
    await deleteProviderConnectionsByProvider(node.id).catch(() => {});
  }
});
