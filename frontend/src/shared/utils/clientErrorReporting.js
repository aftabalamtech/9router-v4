// Client-side error reporting.
//
// Blank-screen failures are undiagnosable without this: when a render throws,
// React unmounts the whole tree, the DOM is empty, and nothing is left on
// screen to tell you what went wrong. This reporter captures the error BEFORE
// the tree is torn down and ships it to the server log, where it can be read
// alongside the API request that preceded it.
//
// SAFETY
// Error messages and stacks can contain whatever the failing code put in them,
// including a token that was interpolated into a URL. Every payload is scrubbed
// of credential-shaped strings and common header names before it leaves the
// browser. Nothing here reads cookies or storage values.

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
const ENDPOINT = "/api/client-errors";

// Same shapes as the backend redaction, applied before anything is sent.
const REDACTIONS = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(sk|pk|rk|api|key)[-_][A-Za-z0-9._-]{12,}\b/gi, "[redacted-key]"],
  [/(authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*("?)[^\s,;"']{4,}\2/gi, "$1=[redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]"],
];

function scrub(value, max) {
  if (typeof value !== "string") return value ?? null;
  let out = value;
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function describe(err) {
  if (!err) return { message: "Unknown error" };
  if (typeof err === "string") return { message: scrub(err, MAX_MESSAGE), stack: null };
  return {
    message: scrub(err?.message || String(err), MAX_MESSAGE),
    stack: scrub(err?.stack, MAX_STACK),
    name: err?.name || null,
  };
}

let queue = [];
let flushing = false;

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: batch }),
      keepalive: true,
    });
  } catch {
    // Reporting must never throw into the app: a failed report is dropped, not
    // retried forever, so a broken endpoint cannot create a request loop.
  } finally {
    flushing = false;
  }
}

function report(kind, err, context = {}) {
  const entry = {
    kind,
    ...describe(err),
    context: {
      route: typeof location !== "undefined" ? location.pathname : null,
      ...context,
    },
    at: new Date().toISOString(),
  };
  queue.push(entry);
  if (queue.length > 20) queue = queue.slice(-20); // bound memory
  // Debounce so an error storm produces a handful of requests, not hundreds.
  setTimeout(flush, 250);
}

export function reportError(err, context) {
  report("error", err, context);
}

export function reportMessage(message, context) {
  report("message", { message }, context);
}

/** Install the global handlers. Idempotent. */
export function installGlobalErrorReporting() {
  if (typeof window === "undefined") return;
  if (window.__9rErrorReporting) return;
  window.__9rErrorReporting = true;

  window.addEventListener("error", (event) => {
    // A resource load failure (script/css) has no Error object; report it too,
    // because a failed module import is exactly the kind of failure that
    // leaves a blank page with no console-visible React error.
    if (event.error) {
      report("error", event.error, { source: event.filename, line: event.lineno });
    } else {
      reportMessage(`Failed to load resource: ${event.target?.tagName || "resource"} ${event.target?.src || event.target?.href || ""}`.trim());
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    report("unhandledrejection", event.reason, { kind: "promise" });
  });
}

export default installGlobalErrorReporting;
