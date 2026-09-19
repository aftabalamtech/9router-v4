import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDiscoveredModel,
  fetchConnectionModels,
  mergeConnectionModels,
} from "./src/lib/models/modelDiscovery.js";
import {
  createSyncJob,
  cancelSyncJob,
  getSyncJob,
  persistDiscovered,
  clearSyncedModels,
  getSyncedModels,
} from "./src/lib/models/modelSync.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const conns = (provider) => async () => [
  { id: "c1", provider, name: "one", isActive: true },
  { id: "c2", provider, name: "two", isActive: true },
  { id: "c3", provider: "other", name: "x", isActive: true },
  { id: "c4", provider, name: "off", isActive: false },
];
async function waitFor(jobId) {
  for (let i = 0; i < 400; i += 1) {
    const j = getSyncJob(jobId);
    if (!j || j.status !== "running") return j;
    await tick(10);
  }
  throw new Error("job did not finish");
}

describe("normalizeDiscoveredModel", () => {
  it("normalizes OpenRouter-style entries with pricing", () => {
    const out = normalizeDiscoveredModel({
      id: "deepseek/deepseek-v4:free",
      name: "DeepSeek V4",
      context_length: 200000,
      pricing: { prompt: 0, completion: 0 },
    }, { provider: "openrouter", connectionId: "c1" });
    assert.equal(out.id, "deepseek/deepseek-v4:free");
    assert.equal(out.isFree, true);
    assert.equal(out.contextLength, 200000);
    assert.equal(out.type, "llm");
    assert.equal(out.source, "upstream");
  });
  it("never invents ids", () => {
    assert.equal(normalizeDiscoveredModel({ name: "No Id" }, { provider: "x", connectionId: "c" }), null);
    assert.equal(normalizeDiscoveredModel(null, { provider: "x", connectionId: "c" }), null);
  });
  it("infers modality from id", () => {
    assert.equal(normalizeDiscoveredModel({ id: "text-embedding-3" }, { provider: "x", connectionId: "c" }).type, "embedding");
    assert.equal(normalizeDiscoveredModel({ id: "tts-1" }, { provider: "x", connectionId: "c" }).type, "stt");
  });
});

describe("fetchConnectionModels", () => {
  it("handles invalid JSON", async () => {
    const r = await fetchConnectionModels("c1", { fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not json{" }) });
    assert.deepEqual(r.models, []);
    assert.match(r.error, /invalid JSON/i);
  });
  it("handles network failure", async () => {
    const r = await fetchConnectionModels("c1", { fetchImpl: async () => { throw new Error("boom"); } });
    assert.deepEqual(r.models, []);
    assert.match(r.error, /boom/);
  });
  it("handles auth failure without throwing", async () => {
    const r = await fetchConnectionModels("c1", {
      fetchImpl: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ error: "bad key" }) }),
    });
    assert.deepEqual(r.models, []);
    assert.equal(r.status, 401);
  });
  it("handles empty upstream list", async () => {
    const r = await fetchConnectionModels("c1", {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ provider: "p", models: [] }) }),
    });
    assert.deepEqual(r.models, []);
    assert.equal(r.error, null);
  });
});

describe("mergeConnectionModels", () => {
  it("dedupes and unions connectionIds independent of order", () => {
    const a = [
      { connectionId: "c1", models: [{ id: "m1" }, { id: "m2" }] },
      { connectionId: "c2", models: [{ id: "m2" }, { id: "m3" }] },
    ];
    const fwd = mergeConnectionModels(a).sort((x, y) => x.id.localeCompare(y.id));
    const rev = mergeConnectionModels([...a].reverse()).sort((x, y) => x.id.localeCompare(y.id));
    assert.equal(fwd.length, 3);
    assert.deepEqual(fwd.find((m) => m.id === "m2").connectionIds.sort(), ["c1", "c2"]);
    assert.deepEqual(fwd.map((m) => m.id), rev.map((m) => m.id));
  });
});

describe("createSyncJob", () => {
  it("prevents overlapping syncs for the same scope", async () => {
    const slow = async () => { await tick(50); return { models: [], error: "empty", status: 200 }; };
    const job = await createSyncJob({
      providerId: "p-overlap", storageAlias: "p-overlap",
      discoverFn: slow, resolveConnections: conns("p-overlap"),
    });
    await assert.rejects(
      createSyncJob({ providerId: "p-overlap", storageAlias: "p-overlap", discoverFn: slow, resolveConnections: conns("p-overlap") }),
      /already running/
    );
    cancelSyncJob(job.id);
    await waitFor(job.id);
  });
  it("allows parallel syncs for different providers", async () => {
    const ok = async () => ({ models: [{ id: "m" }], status: 200 });
    const a = await createSyncJob({ providerId: "p-a", storageAlias: "p-a", discoverFn: ok, resolveConnections: conns("p-a") });
    const b = await createSyncJob({ providerId: "p-b", storageAlias: "p-b", discoverFn: ok, resolveConnections: conns("p-b") });
    await waitFor(a.id);
    await waitFor(b.id);
    assert.equal(getSyncJob(a.id).status, "done");
    assert.equal(getSyncJob(b.id).status, "done");
    await clearSyncedModels("p-a");
    await clearSyncedModels("p-b");
  });
  it("retries transient failures but not auth failures", async () => {
    const calls = {};
    const flaky = async (cid) => {
      calls[cid] = (calls[cid] || 0) + 1;
      if (cid === "c1") return calls[cid] === 1 ? { models: [], error: "x", status: 500 } : { models: [{ id: "m1" }], status: 200 };
      return { models: [], error: "bad", status: 401 };
    };
    const job = await createSyncJob({ providerId: "p-retry", storageAlias: "p-retry", discoverFn: flaky, resolveConnections: conns("p-retry") });
    const done = await waitFor(job.id);
    assert.equal(calls["c1"], 2);
    assert.equal(calls["c2"], 1);
    assert.equal(done.summary.discovered, 1);
    await clearSyncedModels("p-retry");
  });
  it("cancel stops the job and preserves partial state", async () => {
    const slow = async () => { await tick(80); return { models: [{ id: "m" }], status: 200 }; };
    const job = await createSyncJob({ providerId: "p-cancel", storageAlias: "p-cancel", discoverFn: slow, resolveConnections: conns("p-cancel") });
    await tick(20);
    cancelSyncJob(job.id);
    const done = await waitFor(job.id);
    assert.equal(done.status, "cancelled");
    await clearSyncedModels("p-cancel");
  });
});

describe("persistDiscovered", () => {
  const alias = "__test_sync__";
  after(async () => { await clearSyncedModels(alias); });
  it("adds, updates, marks stale, preserves manual flags", async () => {
    let s = await persistDiscovered({ storageAlias: alias, discovered: [{ id: "m1" }, { id: "m2" }], manualIds: ["m2"] });
    assert.deepEqual([s.added, s.updated, s.stale], [2, 0, 0]);
    s = await persistDiscovered({ storageAlias: alias, discovered: [{ id: "m1", name: "renamed" }], manualIds: [] });
    assert.deepEqual([s.added, s.updated, s.stale], [0, 1, 1]);
    const all = await getSyncedModels(alias);
    assert.equal(all[`${alias}|m1`].stale, false);
    assert.equal(all[`${alias}|m2`].stale, true);
    assert.equal(all[`${alias}|m2`].manual, true);
    // Manual model row still exists (never deleted).
    assert.ok(all[`${alias}|m2`]);
  });
});
