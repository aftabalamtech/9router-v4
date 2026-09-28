/**
 * Regression tests for live provider-connection status updates.
 *
 * Root cause: connection status changes (test results, runtime 401/429s,
 * OAuth refreshes, CRUD) were persisted by the backend but the dashboard only
 * saw them after remounting a page and waiting out the 30s cachedJson TTL.
 *
 * Fix: every write in connectionsRepo publishes a sanitized event on an
 * in-process bus (SSE-streamed to clients) and bumps a DB-backed revision so
 * any worker/client can detect missed changes. These tests pin the bus
 * semantics: sanitization (no secrets ever), ordering, replay, quiet-update
 * throttling, and that repo writes actually publish.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-conn-events-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-conn-events";

const { publishConnectionEvent, getConnectionEventEmitter, getConnectionEventsRevision, recoverConnectionEventsSince, resetConnectionEventState } = await import("../src/lib/events/connectionEvents.js");
const {
  createProviderConnection,
  updateProviderConnection,
  deleteProviderConnection,
} = await import("../src/lib/localDb.js");

// The repo publishes events fire-and-forget (writes must never wait on the
// bus); a short settle makes assertions deterministic.
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test("publishConnectionEvent strips secret fields from every event shape", async () => {
  const received = [];
  const onEvent = (e) => received.push(e);
  getConnectionEventEmitter().on("connection", onEvent);

  await publishConnectionEvent({
    type: "updated",
    id: "conn-1",
    provider: "antigravity",
    fields: ["testStatus", "lastError"],
    // hostile input — must never survive sanitization
    apiKey: "sk-super-secret",
    accessToken: "ya29.secret",
    refreshToken: "1//refresh",
    cookie: "session=steal-me",
    nested: { apiKey: "nested-secret", ok: "fine" },
  });

  getConnectionEventEmitter().off("connection", onEvent);
  assert.equal(received.length, 1);
  const ev = received[0];
  assert.equal(ev.apiKey, undefined);
  assert.equal(ev.accessToken, undefined);
  assert.equal(ev.refreshToken, undefined);
  assert.equal(ev.cookie, undefined);
  // The event body is a whitelist: metadata + fields + ts + revision only.
  assert.equal(ev.nested, undefined, "unrecognized payload keys are dropped");
  assert.ok(Array.isArray(ev.fields));
  assert.equal(typeof ev.revision, "number");
});

test("revisions increase monotonically and are persisted across bus resets", async () => {
  resetConnectionEventState();
  const rev1 = await getConnectionEventsRevision();
  await publishConnectionEvent({ type: "updated", id: "r1", provider: "p", fields: ["testStatus"] });
  const rev2 = await getConnectionEventsRevision();
  assert.equal(rev2, rev1 + 1);

  // A second "worker" (fresh module state) reads the same authoritative revision.
  resetConnectionEventState();
  const rev3 = await getConnectionEventsRevision();
  assert.equal(rev3, rev2, "revision must survive in-memory resets (DB-backed)");
});

test("recoverConnectionEventsSince replays missed events in order", async () => {
  const before = await getConnectionEventsRevision();
  await publishConnectionEvent({ type: "updated", id: "c-a", provider: "x", fields: ["lastError"] });
  await publishConnectionEvent({ type: "updated", id: "c-b", provider: "x", fields: ["testStatus"] });
  const missed = await recoverConnectionEventsSince(before);
  assert.ok(missed.length >= 2);
  assert.equal(missed[0].id, "c-a");
  assert.equal(missed[1].id, "c-b");
  assert.ok(missed.every((m) => m.revision > before));
  // no secrets in replay either
  assert.ok(missed.every((m) => m.apiKey === undefined && m.accessToken === undefined));
});

test("quiet usage-bookkeeping updates are throttled, status changes are not", async () => {
  resetConnectionEventState();
  const received = [];
  const onEvent = (e) => received.push(e);
  getConnectionEventEmitter().on("connection", onEvent);
  try {
    await publishConnectionEvent({ type: "updated", id: "q", provider: "p", fields: ["lastUsedAt"] });
    await publishConnectionEvent({ type: "updated", id: "q", provider: "p", fields: ["lastUsedAt"] });
    await publishConnectionEvent({ type: "updated", id: "q", provider: "p", fields: ["consecutiveUseCount"] });
    await publishConnectionEvent({ type: "updated", id: "q", provider: "p", fields: ["testStatus"] });
    await publishConnectionEvent({ type: "updated", id: "q", provider: "p", fields: ["lastError"] });
  } finally {
    getConnectionEventEmitter().off("connection", onEvent);
  }
  const quiet = received.filter((e) => e.fields.every((f) => f === "lastUsedAt" || f === "consecutiveUseCount"));
  assert.equal(quiet.length, 1, "burst of usage updates collapses to one event");
  const status = received.filter((e) => e.fields.includes("testStatus") || e.fields.includes("lastError"));
  assert.equal(status.length, 2, "status changes always publish immediately");
});

test("repo writes publish lifecycle events (created → updated → deleted)", async () => {
  resetConnectionEventState();
  const received = [];
  const onEvent = (e) => received.push(e);
  getConnectionEventEmitter().on("connection", onEvent);
  try {
    const conn = await createProviderConnection({
      provider: "openrouter",
      authType: "apikey",
      name: "events-test-key",
      apiKey: "sk-events-test",
      isActive: true,
      priority: 1,
    });
    assert.ok(conn?.id);

    await updateProviderConnection(conn.id, {
      testStatus: "error",
      lastError: "[404]: Requested entity was not found",
      lastErrorAt: new Date().toISOString(),
    });

    await deleteProviderConnection(conn.id);
    await settle();
  } finally {
    getConnectionEventEmitter().off("connection", onEvent);
  }

  const types = received.map((e) => e.type);
  assert.deepEqual(types, ["created", "updated", "deleted"]);
  const updated = received[1];
  assert.equal(updated.provider, "openrouter");
  assert.ok(updated.fields.includes("testStatus"));
  assert.ok(updated.fields.includes("lastError"));
  // The stored API key itself must never ride along in event metadata.
  assert.equal(JSON.stringify(updated).includes("sk-events-test"), false);
});
