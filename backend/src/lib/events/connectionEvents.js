// Connection event bus — the backend half of live provider status updates.
//
// Every persisted change to a provider connection (connection tests, runtime
// 401/429 errors, OAuth token refreshes, CRUD) flows through
// connectionsRepo.js, which calls publishConnectionEvent() here. The SSE
// route (routes/providers/events/route.ts) streams these events to the
// dashboard so status badges and error messages update without a reload.
//
// Design notes:
// - The revision counter is persisted in the `kv` table (scope
//   "connection_events"), so it is authoritative and shared by every backend
//   worker/instance on both SQLite and PostgreSQL. In-memory state here is
//   only a transport, never the source of truth.
// - Every event is stored under its sequence number, forming a small
//   replayable backlog. A client that reconnects with `?since=<rev>` gets the
//   missed events instead of waiting for the next cache expiry.
// - Events carry connection METADATA ONLY (id, provider, changed field
//   names). Secrets are stripped defensively by sanitizeEvent() — they must
//   never reach the browser or the logs.
// - Per-connection throttling collapses noisy updates (round-robin
//   lastUsedAt bookkeeping) while always letting meaningful status changes
//   through.

import { EventEmitter } from "node:events";
import { getAdapter } from "../db/driver.js";
import { parseJson, stringifyJson } from "../db/helpers/jsonCol.js";

const CHANNEL = "connection_events";
const REV_KEY = "revision";
const MAX_BACKLOG = 300;
const PRUNE_EVERY = 100;
const QUIET_THROTTLE_MS = 250;

// Fields that change on every routed request (usage bookkeeping). Updates
// touching ONLY these fields are throttled per connection.
const QUIET_FIELDS = new Set(["lastUsedAt", "consecutiveUseCount"]);

// Any event field name that could carry a credential is stripped before an
// event is published or stored.
const SECRET_FIELD_NAMES = new Set([
  "apiKey", "accessToken", "refreshToken", "idToken", "cookie",
  "cached_jwt", "copilotToken", "authorization", "password", "secret",
]);

const state = globalThis._connectionEventsState || (globalThis._connectionEventsState = {
  emitter: null,
  seqCounter: 0,
  publishCount: 0,
  lastQuietPublishAt: new Map(), // connectionId -> ts
  revisionCache: null,
  revisionCacheAt: 0,
});

export function getConnectionEventEmitter() {
  if (!state.emitter) {
    state.emitter = new EventEmitter();
    // SSE clients each add one listener; allow a healthy dashboard fan-out.
    state.emitter.setMaxListeners(200);
  }
  return state.emitter;
}

function sanitizeValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 4) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeValue(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD_NAMES.has(k)) continue;
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

/** Strip anything secret-looking from an event before publish/storage. */
export function sanitizeEvent(event) {
  return sanitizeValue(event) || {};
}

function isQuietUpdate(fields) {
  return Array.isArray(fields) && fields.length > 0 && fields.every((f) => QUIET_FIELDS.has(f));
}

async function bumpRevision(event) {
  const db = await getAdapter();
  let seq = 0;
  await db.transaction(async () => {
    // Atomic increment in SQL: two workers racing on the same row are
    // serialized by the row lock inside ON CONFLICT, so revisions are unique
    // across instances on both SQLite and PostgreSQL (value is numeric JSON).
    await db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
       ON CONFLICT(scope, key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
      [CHANNEL, REV_KEY, stringifyJson(1)]
    );
    const row = await db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [CHANNEL, REV_KEY]);
    const current = row ? parseJson(row.value, 0) : 0;
    seq = Number.isFinite(current) ? current : 0;
    await db.run(
      `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
      [CHANNEL, String(seq), stringifyJson(event)]
    );
  });
  state.revisionCache = seq;
  state.revisionCacheAt = Date.now();
  return seq;
}

async function pruneBacklog(latestSeq) {
  const db = await getAdapter();
  const rows = await db.all(`SELECT key FROM kv WHERE scope = ?`, [CHANNEL]);
  const cutoff = latestSeq - MAX_BACKLOG;
  for (const r of rows) {
    const n = Number.parseInt(r.key, 10);
    if (Number.isFinite(n) && n <= cutoff) {
      await db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [CHANNEL, r.key]).catch(() => {});
    }
  }
}

/**
 * Publish a connection event. Safe to call fire-and-forget; never throws.
 * @param {{ type: string, id: string, provider: string, fields?: string[] }} event
 */
export async function publishConnectionEvent(event) {
  try {
    if (!event || !event.id || !event.type) return;
    const fields = Array.isArray(event.fields) ? event.fields.filter((f) => typeof f === "string") : [];

    // Throttle pure usage-bookkeeping updates per connection; meaningful
    // status changes (testStatus, lastError, isActive, ...) always publish.
    if (isQuietUpdate(fields)) {
      const now = Date.now();
      const last = state.lastQuietPublishAt.get(event.id) || 0;
      if (now - last < QUIET_THROTTLE_MS) return;
      state.lastQuietPublishAt.set(event.id, now);
      if (state.lastQuietPublishAt.size > 1000) state.lastQuietPublishAt.clear();
    }

    const payload = sanitizeEvent({
      type: event.type,
      id: event.id,
      provider: event.provider || null,
      fields,
      ts: new Date().toISOString(),
    });

    const seq = await bumpRevision(payload);
    payload.revision = seq;

    getConnectionEventEmitter().emit("connection", payload);

    state.publishCount += 1;
    if (state.publishCount % PRUNE_EVERY === 0) {
      await pruneBacklog(seq).catch(() => {});
    }
  } catch (err) {
    // Event publication must never break the write that triggered it.
    console.log("[connectionEvents] publish failed:", err?.message || err);
  }
}

/** Authoritative revision across all workers (1s in-memory cache). */
export async function getConnectionEventsRevision() {
  const now = Date.now();
  if (state.revisionCache != null && now - state.revisionCacheAt < 1000) return state.revisionCache;
  try {
    const db = await getAdapter();
    const row = await db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [CHANNEL, REV_KEY]);
    const value = row ? parseJson(row.value, 0) : 0;
    state.revisionCache = Number.isFinite(value) ? value : 0;
    state.revisionCacheAt = now;
    return state.revisionCache;
  } catch {
    return state.revisionCache ?? 0;
  }
}

/**
 * Events with seq > since, oldest first (capped). Used to replay a
 * reconnecting client's missed window.
 */
export async function recoverConnectionEventsSince(since, limit = 500) {
  const db = await getAdapter();
  const rows = await db.all(`SELECT key, value FROM kv WHERE scope = ?`, [CHANNEL]);
  const parsed = [];
  for (const r of rows) {
    const seq = Number.parseInt(r.key, 10);
    if (!Number.isFinite(seq) || seq <= since) continue;
    const ev = parseJson(r.value, null);
    if (ev) parsed.push({ seq, ev });
  }
  parsed.sort((a, b) => a.seq - b.seq);
  return parsed.slice(-limit).map(({ seq, ev }) => ({ ...ev, revision: seq }));
}

/** Test/diagnostic hook: reset in-memory throttles/caches (not persisted data). */
export function resetConnectionEventState() {
  state.seqCounter = 0;
  state.publishCount = 0;
  state.lastQuietPublishAt.clear();
  state.revisionCache = null;
  state.revisionCacheAt = 0;
  if (state.emitter) state.emitter.removeAllListeners();
}
