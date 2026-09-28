// GET /api/providers/events — live provider-connection status stream (SSE).
//
// The dashboard subscribes once per open page; every persisted connection
// change (test result, runtime 401/429, OAuth refresh, CRUD) arrives here
// within milliseconds of the DB write. This removes the need for the UI to
// poll /api/providers or wait for its 30s cache TTL.
//
// Delivery layers:
//   1. In-process EventEmitter — instant push for the common single-instance
//      setup (same pattern as usage/stream and the console-log stream).
//   2. DB-backed revision + replay backlog — on reconnect (EventSource
//      auto-retry or fresh page) the client sends its last revision via
//      Last-Event-ID (or ?since=), and missed events are replayed from the
//      `kv` backlog. Every 10s the current revision is sent as a `revision`
//      event so a client that connected to a DIFFERENT worker instance (in-
//      memory bus has nothing for it) still converges and refetches.
//
// Multiple instances: each instance streams its own in-memory events plus the
// shared revision; no cross-worker bus is required because the DB is the
// coordination point.
//
// Security: events contain connection metadata only (no apiKey/token/cookie —
// see sanitizeEvent in connectionEvents.js). Access control matches the rest
// of /api/providers via middleware/auth.ts (PROTECTED_API_PATHS).

import {
  getConnectionEventEmitter,
  getConnectionEventsRevision,
  recoverConnectionEventsSince,
} from "../../../lib/events/connectionEvents.js";

export const dynamic = "force-dynamic";

export async function GET_handler(req, res) {
  const encoder = new TextEncoder();
  const url = new URL(req.originalUrl || req.url, "http://localhost");
  const lastEventIdHeader = req.headers["last-event-id"];
  const sinceRaw = url.searchParams.get("since") ?? (Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader);
  const since = Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : 0;

  const state = { closed: false, onEvent: null, keepalive: null, revisionTick: null, cleanup: null };
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event, id, eventName) => {
        if (state.closed) return;
        try {
          let frame = "";
          if (id !== undefined) frame += `id: ${id}\n`;
          if (eventName) frame += `event: ${eventName}\n`;
          frame += `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          state.cleanup?.("enqueue-failed");
        }
      };

      state.onEvent = (event) => send(event, event.revision);
      try {
        // 1. Catch up on anything missed while disconnected.
        if (since > 0) {
          const missed = await recoverConnectionEventsSince(since);
          for (const ev of missed) send(ev, ev.revision);
        }
        // 2. Tell the client where the server is now.
        send({ revision: await getConnectionEventsRevision() }, undefined, "revision");

        getConnectionEventEmitter().on("connection", state.onEvent);
      } catch (err) {
        console.log("[providers/events] initial sync failed:", err?.message || err);
      }

      // 3. Keepalive so proxies (Cloudflare tunnel, Nginx, Render) hold the
      //    connection open; also detects dead sockets.
      state.keepalive = setInterval(() => {
        if (state.closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          state.cleanup?.("keepalive-failed");
        }
      }, 25000);

      // 4. Periodic revision broadcast: if this worker never sees the in-memory
      //    event (another instance persisted the change), the client still
      //    learns the revision moved and refetches /api/providers.
      state.revisionTick = setInterval(async () => {
        if (state.closed) return;
        try {
          send({ revision: await getConnectionEventsRevision() }, undefined, "revision");
        } catch {
          /* transient DB error — next tick retries */
        }
      }, 10000);

      state.cleanup = (reason) => {
        if (state.closed) return;
        state.closed = true;
        if (state.onEvent) getConnectionEventEmitter().off("connection", state.onEvent);
        clearInterval(state.keepalive);
        clearInterval(state.revisionTick);
        try { controller.close(); } catch { /* already closed */ }
        console.log(`[providers/events] client disconnected (${reason})`);
      };
    },
    cancel() {
      state.cleanup?.("client-cancel");
    },
  });

  // Express (autoRouter): pipe the web ReadableStream, ending on client close.
  req.on("close", () => state.cleanup?.("req-close"));

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
