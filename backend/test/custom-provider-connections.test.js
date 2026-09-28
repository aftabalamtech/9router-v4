// Custom-provider connection planning against a real in-memory database.
//
// Verifies the multi-connection change end to end on the actual repository
// (SQLite adapter in-process, no mocks): many connections per custom node,
// per-connection credential isolation, and idempotent bulk import.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "9r-conn-"));
// The DB layer persists under `${DATA_DIR}/db`, so the directory must exist
// before initDb() runs (the sql.js fallback in particular writes there).
mkdirSync(join(dataDir, "db"), { recursive: true });
process.env.DATA_DIR = dataDir;
process.env.DATABASE_URL = ""; // force the SQLite path

const { initDb } = await import("../src/lib/db/index.js");
const { getProviderConnections, getProviderConnectionById } = await import("../src/lib/localDb.js");
const { planBulkConnections } = await import("../src/lib/models/bulkConnections.js");

const PROVIDER = "openai-compatible-chat-11111111-2222-3333-4444-555555555555";

before(async () => {
  await initDb();
});

after(async () => {
  // The sql.js adapter keeps a write-back timer alive; close the DB before
  // deleting the directory so it does not log an ENOENT on a removed file.
  try {
    const { getAdapter } = await import("../src/lib/db/driver.js");
    const db = await getAdapter();
    await db.close?.();
  } catch {}
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

/**
 * Mirror of the route's write path (node fields merged UNDER the caller's own
 * providerSpecificData), so the test exercises real persistence and the real
 * merge semantics.
 */
async function createConnection(overrides = {}) {
  const { createProviderConnection } = await import("../src/lib/localDb.js");
  const { providerSpecificData, ...rest } = overrides;
  return createProviderConnection({
    provider: PROVIDER,
    authType: "apikey",
    testStatus: "unknown",
    ...rest,
    providerSpecificData: {
      prefix: "xk",
      apiType: "chat",
      baseUrl: "https://api.xkiro.example/v1",
      nodeName: "Xkiro",
      ...(providerSpecificData || {}),
    },
  });
}

describe("multiple connections per custom provider", () => {
  it("creates and keeps several independent connections on one node", async () => {
    const a = await createConnection({ name: "Main", apiKey: "sk-main-key-value" });
    const b = await createConnection({ name: "Backup", apiKey: "sk-backup-key-value" });
    const c = await createConnection({ name: "Team 3", apiKey: "sk-team3-key-value" });

    assert.notEqual(a.id, b.id);
    const all = await getProviderConnections({ provider: PROVIDER });
    assert.ok(all.length >= 3, `expected >=3 connections, got ${all.length}`);

    // Every connection keeps its OWN credential — creating a second one must
    // never overwrite the first.
    for (const conn of all) {
      const fresh = await getProviderConnectionById(conn.id);
      assert.equal(typeof fresh.apiKey, "string");
      assert.ok(fresh.apiKey.length > 0, `${fresh.name} lost its api key`);
    }
    const byName = new Map((await getProviderConnections({ provider: PROVIDER })).map((c) => [c.name, c.apiKey]));
    assert.equal(byName.get("Main"), "sk-main-key-value");
    assert.equal(byName.get("Backup"), "sk-backup-key-value");
    assert.equal(byName.get("Team 3"), "sk-team3-key-value");
  });

  it("inherits the node's prefix/baseUrl/nodeName on every connection", async () => {
    for (const conn of await getProviderConnections({ provider: PROVIDER })) {
      const psd = conn.providerSpecificData || {};
      assert.equal(psd.prefix, "xk");
      assert.equal(psd.baseUrl, "https://api.xkiro.example/v1");
      assert.equal(psd.nodeName, "Xkiro");
      assert.equal(psd.apiType, "chat");
    }
  });

  it("a per-connection baseUrl override survives (multi-endpoint setups)", async () => {
    const override = await createConnection({
      name: "Alt endpoint",
      apiKey: "sk-alt-key-value",
      providerSpecificData: { baseUrl: "https://alt.xkiro.example/v1" },
    });
    const fresh = await getProviderConnectionById(override.id);
    assert.equal(fresh.providerSpecificData.baseUrl, "https://alt.xkiro.example/v1");
    // Node-level fields still apply where the connection did not override.
    assert.equal(fresh.providerSpecificData.prefix, "xk");
    assert.equal(fresh.providerSpecificData.nodeName, "Xkiro");
  });

  it("disabling one connection does not affect the others", async () => {
    const { updateProviderConnection } = await import("../src/lib/localDb.js");
    const target = await getProviderConnectionById((await getProviderConnections({ provider: PROVIDER }))[0].id);
    await updateProviderConnection(target.id, { isActive: false });
    const all = await getProviderConnections({ provider: PROVIDER });
    const reloaded = await getProviderConnectionById(target.id);
    assert.equal(reloaded.isActive, false);
    assert.ok(all.some((c) => c.isActive !== false), "other connections must stay active");
  });
});

describe("bulk import is idempotent and key-safe", () => {
  it("a second identical bulk import skips every key as a duplicate", async () => {
    const existing = await getProviderConnections({ provider: PROVIDER });
    const plan = planBulkConnections(
      existing.map((c) => ({ name: c.name, apiKey: c.apiKey })),
      { existingConnections: existing, defaultNamePrefix: "Xkiro" }
    );
    assert.equal(plan.valid.length, 0, "no key should be accepted twice");
    assert.ok(plan.duplicates.length > 0);
  });

  it("auto-named keys do not collide with each other across two pastes", async () => {
    const first = planBulkConnections(
      [{ apiKey: "sk-bulk-aaaa-1" }, { apiKey: "sk-bulk-aaaa-2" }],
      { existingConnections: await getProviderConnections({ provider: PROVIDER }), defaultNamePrefix: "Xkiro" }
    );
    assert.equal(first.valid.length, 2);
    // Simulate the second paste: both keys now exist, and both auto-names are taken.
    const afterFirst = [
      ...(await getProviderConnections({ provider: PROVIDER })),
      { name: first.valid[0].name, apiKey: first.valid[0].apiKey },
      { name: first.valid[1].name, apiKey: first.valid[1].apiKey },
    ];
    const second = planBulkConnections(
      [{ apiKey: "sk-bulk-bbbb-1" }, { apiKey: "sk-bulk-bbbb-2" }],
      { existingConnections: afterFirst, defaultNamePrefix: "Xkiro" }
    );
    const names = second.valid.map((v) => v.name);
    assert.equal(new Set(names).size, names.length, "auto-generated names must be unique");
    // The second paste's keys are new, so nothing is skipped or rejected.
    assert.equal(second.duplicates.length, 0);
    assert.equal(second.invalid.length, 0);
    // ...and none of them reuses a name already taken by the first paste.
    const takenBefore = new Set(afterFirst.map((c) => c.name));
    for (const name of names) assert.equal(takenBefore.has(name), false, `reused name: ${name}`);
  });

  it("an invalid entry never blocks the valid ones", async () => {
    const plan = planBulkConnections(
      [
        { name: "Good one", apiKey: "sk-valid-entry-1" },
        { name: "Bad", apiKey: "" },
        { name: "Good two", apiKey: "sk-valid-entry-2" },
      ],
      { existingConnections: [], defaultNamePrefix: "Xkiro" }
    );
    assert.deepEqual(plan.valid.map((v) => v.name), ["Good one", "Good two"]);
    assert.equal(plan.invalid.length, 1);
  });
});
