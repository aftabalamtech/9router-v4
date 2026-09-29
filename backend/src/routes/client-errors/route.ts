// POST /api/client-errors - receives browser-side error reports.
//
// Written to the server log so a blank-screen failure (which leaves nothing
// on screen) can be traced back to the error that caused it. Payloads are
// scrubbed again here: the browser is not the only thing writing to this log,
// and a defensive second pass costs nothing.
import { scrubLogText } from "../../lib/net/scrubLog.js";

const MAX_ENTRIES = 20;
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;

// Only these keys are logged. An allow-list means a future frontend change
// cannot accidentally ship a whole object (or a request body) into the log.
const ALLOWED_CONTEXT = new Set(["route", "source", "line", "kind", "component"]);

function clip(value, max) {
  if (typeof value !== "string") return null;
  return scrubLogText(value).slice(0, max);
}

export async function POST_handler(req, res) {
  try {
    const { entries } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "entries[] required" });
    }
    for (const raw of entries.slice(0, MAX_ENTRIES)) {
      if (!raw || typeof raw !== "object") continue;
      const context = {};
      for (const [key, value] of Object.entries(raw.context || {})) {
        if (!ALLOWED_CONTEXT.has(key)) continue;
        context[key] = typeof value === "string" ? clip(value, 200) : null;
      }
      console.error(
        "[client-error]",
        JSON.stringify({
          kind: clip(raw.kind, 40) || "error",
          message: clip(raw.message, MAX_MESSAGE),
          stack: clip(raw.stack, MAX_STACK),
          context,
          at: clip(raw.at, 40) || null,
        })
      );
    }
    return res.json({ ok: true, logged: Math.min(entries.length, MAX_ENTRIES) });
  } catch (error) {
    // Never let a logging failure become a 500 the browser then retries.
    return res.json({ ok: true, logged: 0 });
  }
}
