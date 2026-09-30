/**
 * Safe JSON reader for dashboard API calls.
 *
 * Root cause of `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`:
 * validation and other flows called `res.json()` unconditionally. When a
 * response is NOT JSON — an upstream HTML page relayed by the backend, a
 * reverse-proxy error page, a login redirect, an empty body — the browser threw
 * a raw SyntaxError, and the UI showed a parser message instead of the actual
 * failure category.
 *
 * `readJsonResponse` never throws. It inspects status and Content-Type, and
 * returns a structured result the caller can render:
 *   { ok, status, data, contentType, error }
 */

/** Content types that should never be parsed as JSON. */
const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;

function isJsonContentType(contentType) {
  if (!contentType) return false;
  return /\bjson\b/i.test(contentType);
}

/**
 * Human-readable summary of a non-JSON body, safe to show in the UI.
 * HTML is reduced to a short descriptor instead of being dumped into the DOM.
 */
function describeBody(text, contentType) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  if (HTML_CONTENT_TYPE.test(contentType || "") || /^<(!doctype|html)/i.test(trimmed)) {
    return "The server returned an HTML page instead of API JSON (wrong base URL, a proxy/CDN page, or the app is not running correctly).";
  }
  return trimmed.slice(0, 200);
}

/**
 * @param {Response} res
 * @param {{ label?: string }} [options]
 * @returns {Promise<{ ok: boolean, status: number, data: object|null, contentType: string, error: string }>}
 */
export async function readJsonResponse(res, { label = "request" } = {}) {
  const status = typeof res?.status === "number" ? res.status : 0;
  const contentType = res?.headers?.get?.("content-type") || "";

  let text = "";
  try {
    text = await res.text();
  } catch {
    text = "";
  }

  if (!text.trim()) {
    const error = res?.ok
      ? `The ${label} returned an empty response.`
      : `The ${label} failed with HTTP ${status} and an empty body.`;
    return { ok: false, status, data: null, contentType, error };
  }

  if (isJsonContentType(contentType) || /^[\[{]/.test(text.trim())) {
    try {
      const data = JSON.parse(text);
      // A JSON body can still describe a failure; surface its message.
      const message = data && typeof data === "object" ? data.error || data.message : null;
      if (res.ok && data && typeof data === "object") {
        return { ok: true, status, data, contentType, error: "" };
      }
      return {
        ok: false,
        status,
        data,
        contentType,
        error: (typeof message === "string" && message) || `The ${label} failed with HTTP ${status}.`,
      };
    } catch {
      // Fall through to the non-JSON branch below.
    }
  }

  const described = describeBody(text, contentType);
  return {
    ok: false,
    status,
    data: null,
    contentType,
    error: described
      ? `${described} (HTTP ${status}${contentType ? `, ${contentType.split(";")[0]}` : ""})`
      : `The ${label} failed with HTTP ${status}.`,
  };
}

/**
 * Convenience wrapper for the provider validation endpoints: always returns a
 * `{ valid, error }`-shaped object so callers can render it directly.
 */
export async function fetchValidationResult(url, payload, { timeoutMs = 15000, label = "validation" } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
    const parsed = await readJsonResponse(res, { label });
    if (parsed.ok) return parsed.data;
    // A 5xx means the app itself failed, not that the credential is invalid.
    // Label it so the user does not go hunting for a bad API key.
    if (parsed.status >= 500) {
      return {
        valid: false,
        error: `9Router could not complete the ${label} (server error ${parsed.status}): ${parsed.error}`,
      };
    }
    return { valid: false, error: parsed.error };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { valid: false, error: `Validation timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    return { valid: false, error: "Could not reach the 9Router API" };
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

export default readJsonResponse;
