// Live connection-event client for the dashboard.
//
// Subscribes to GET /api/providers/events (SSE) once per browser tab and
// notifies subscribers whenever a provider connection changes on the server.
// - Reconnects automatically (EventSource built-in retry) and replays missed
//   events via Last-Event-ID; `onrevision` fires whenever the server reports
//   a revision newer than ours, so a tab can refetch even if the stream was
//   silently replaced (proxy, reconnect to another worker).
// - Disconnects when the tab is hidden to save battery/server work, and
//   reconnects on focus (with a catch-up refetch via onrevision).
// - Auth: the browser sends the 9r_session cookie automatically.

const listeners = new Map(); // handle -> { onEvent, onRevision, onError }
let source = null;
let lastRevision = 0;
let currentHandle = 0;
let connecting = false;
let wantConnected = false;
let hideListenerInstalled = false;
let reconnectTimer = null;

const MAX_SILENT_RETRIES = 3;
let consecutiveFailures = 0;

function shouldNotifyRevision(rev) {
  const isNew = typeof rev === "number" && rev > lastRevision;
  if (isNew) lastRevision = rev;
  return isNew;
}

function open() {
  if (source || connecting || !wantConnected) return;
  if (typeof EventSource === "undefined") return;
  connecting = true;

  const es = new EventSource(`/api/providers/events${lastRevision ? `?since=${lastRevision}` : ""}`);
  source = es;

  es.onopen = () => {
    connecting = false;
    consecutiveFailures = 0;
  };

  es.onmessage = (e) => {
    let event = null;
    try { event = JSON.parse(e.data); } catch { return; }
    if (event && typeof event.revision === "number") {
      if (!shouldNotifyRevision(event.revision)) return; // duplicate/old
    }
    for (const { onEvent } of listeners.values()) {
      try { onEvent?.(event); } catch (err) { console.log("[connectionEvents] listener error:", err); }
    }
  };

  // Server sends a periodic `revision` event; if it's ahead of us we missed
  // something (reconnect to a different worker) — let subscribers refetch.
  es.addEventListener("revision", (e) => {
    let payload = {};
    try { payload = JSON.parse(e.data); } catch { /* ignore */ }
    if (!shouldNotifyRevision(payload.revision)) return;
    for (const { onRevision } of listeners.values()) {
      try { onRevision?.(payload.revision); } catch (err) { console.log("[connectionEvents] listener error:", err); }
    }
  });

  es.onerror = () => {
    connecting = false;
    // EventSource retries on its own; after repeated failures fall back to a
    // slower manual retry so a long outage doesn't hot-loop.
    consecutiveFailures += 1;
    if (consecutiveFailures > MAX_SILENT_RETRIES) {
      try { es.close(); } catch { /* ignore */ }
      source = null;
      for (const { onError } of listeners.values()) onError?.();
      if (wantConnected) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(open, Math.min(30000, 2000 * (consecutiveFailures - MAX_SILENT_RETRIES)));
      }
    } else {
      for (const { onError } of listeners.values()) onError?.();
    }
  };
}

function close() {
  if (source) {
    try { source.close(); } catch { /* ignore */ }
    source = null;
  }
  clearTimeout(reconnectTimer);
  connecting = false;
}

function maybeToggle() {
  const active = wantConnected && typeof document !== "undefined" && document.visibilityState === "visible";
  if (active) open();
  else close();
}

function installVisibilityHandling() {
  if (hideListenerInstalled || typeof document === "undefined") return;
  hideListenerInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Reset backoff so a returning tab reconnects immediately.
      consecutiveFailures = 0;
      maybeToggle();
    } else {
      close();
    }
  });
  window.addEventListener("online", () => {
    consecutiveFailures = 0;
    maybeToggle();
  });
  window.addEventListener("offline", close);
}

/**
 * Subscribe to connection events.
 * @param {{ onEvent?: Function, onRevision?: Function, onError?: Function }} handlers
 * @returns {() => void} unsubscribe
 */
export function subscribeConnectionEvents({ onEvent, onRevision, onError } = {}) {
  installVisibilityHandling();
  const handle = ++currentHandle;
  listeners.set(handle, { onEvent, onRevision, onError });
  wantConnected = true;
  maybeToggle();
  return () => {
    listeners.delete(handle);
    if (listeners.size === 0) {
      wantConnected = false;
      close();
    }
  };
}

/** Last known server revision (for tests/diagnostics). */
export function connectionEventsRevision() {
  return lastRevision;
}
