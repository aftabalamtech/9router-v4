// Shared upstream-failure classification for provider validation.
//
// WHY THIS EXISTS
// There are three separate code paths that can report a provider test result to
// the dashboard, and all three used to decide the message independently:
//
//   1. POST /api/provider-nodes/validate      routes/provider-nodes/validate
//   2. POST /api/providers/validate           routes/providers/validate        <- emits bare "Invalid API key"
//   3. POST /api/providers/[id]/test          routes/providers/[id]/test/testUtils.js <- emits bare "Invalid API key"
//
// Path 2 is what the "Check" button on a saved connection calls, and path 3 is
// what "Test Connection" calls. Both hard-coded `error: "Invalid API key"` for
// ANY 401 or 403, so a Cloudflare challenge page (403 + text/html), a wrong
// endpoint, or an IP block were all reported to the user as an invalid
// credential. The same paths also stored raw upstream HTML into
// `connections.lastError`, which is where messages beginning
// "[502]: <!DOCTYPE html>..." came from.
//
// One classifier, one category vocabulary, one redaction policy — so every
// flow tells the user the same thing.

import { readResponseOnce, parseErrorPayload } from "./httpBody.js";

const HTML_BODY = /^\s*(<!doctype\s+html|<html[\s>])/i;
const CF_MARKERS = /cloudflare|cf-ray|attention required|checking your browser|just a moment|ie6 oldie|enable javascript and cookies/i;

/** Strip markup so an error page can be summarized without echoing a whole page. */
export function sanitizeUpstreamText(text, limit = 160) {
  return String(text || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/** Remove credentials that an upstream may have echoed back into its message. */
export function redactSecrets(text, apiKey = "") {
  let out = String(text || "")
    .replace(/Bearer\s+[^\s"'<>,]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|pk|cc|key|token)[-_][A-Za-z0-9_-]{8,}/g, "$1_[redacted]");
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (key.length >= 8) out = out.split(key).join("[redacted]");
  return out.trim();
}

/** Header names worth returning: they identify the hop that answered. */
const DIAGNOSTIC_HEADERS = ["server", "cf-ray", "cf-mitigated", "via", "x-cache", "location", "content-type", "x-request-id", "retry-after"];

/**
 * Read an upstream response exactly once and describe it.
 *
 * @param {Response} response  upstream response (body is consumed here)
 * @param {{ url?: string, method?: string, hasAuth?: boolean }} [request]
 */
export async function readUpstreamDiagnostic(response, request = {}) {
  const parsed = await readResponseOnce(response);
  const headers = {};
  for (const name of DIAGNOSTIC_HEADERS) {
    const value = response?.headers?.get?.(name);
    if (value) headers[name] = String(value).slice(0, 200);
  }

  const status = response?.status ?? null;
  const raw = String(parsed.text || "").trim();
  const looksHtml = /text\/html|application\/xhtml\+xml/i.test(parsed.contentType || "") || HTML_BODY.test(raw);

  let category;
  if (looksHtml) {
    category = CF_MARKERS.test(`${raw} ${Object.values(headers).join(" ")}`) ? "security_challenge" : "html_response";
  } else if (status === 401) {
    category = "invalid_credentials";
  } else if (status === 403) {
    category = "access_denied";
  } else if (status === 404) {
    category = "wrong_endpoint";
  } else if (status === 405) {
    category = "method_not_allowed";
  } else if (status === 429) {
    category = "rate_limited";
  } else if (status >= 500) {
    category = "upstream_server_error";
  } else if (status >= 400) {
    category = "upstream_http_error";
  } else {
    category = parsed.parsed ? "ok" : "malformed_response";
  }

  return {
    status,
    category,
    contentType: parsed.contentType,
    finalUrl: response?.url || request.url || "",
    redirected: Boolean(response?.redirected),
    // True when the upstream body was not JSON at all (HTML page, plain text,
    // empty). Lets callers tell "405 means no /models here" apart from
    // "405 that actually served an HTML error page".
    nonJsonBody: parsed.nonJsonBody,
    looksHtml,
    request: {
      method: request.method || "",
      url: request.url || "",
      // Presence of a credential, never the credential itself.
      auth: request.hasAuth ? "bearer" : "none",
    },
    headers,
    // Markup-free so an HTML error page can never be relayed into an error
    // string, and redacted so an echoed credential cannot reach the client.
    preview: redactSecrets(sanitizeUpstreamText(raw), request.apiKey),
    // A human-readable upstream reason, same tag-stripping + redaction rules.
    detail: redactSecrets(sanitizeUpstreamText(parseErrorPayload(raw, { status }), 240), request.apiKey),
    json: parsed.json,
    parsed,
  };
}

/** The subset of a diagnostic that is safe to send to a browser. */
export function publicUpstreamDiagnostics(d) {
  return {
    status: d.status,
    category: d.category,
    contentType: d.contentType,
    finalUrl: d.finalUrl,
    redirected: d.redirected,
    request: d.request,
    headers: d.headers,
    preview: d.preview,
  };
}

/** Human-readable, actionable message for a diagnostic's category. */
export function describeUpstreamFailure(d, { apiKey = "", noun = "Upstream" } = {}) {
  const detail = redactSecrets(d.detail, apiKey);
  switch (d.category) {
    case "security_challenge":
      return `${noun} returned a security challenge or access-filter page (HTTP ${d.status}). This is an upstream/network block, not an API key problem; 9Router will not attempt to bypass it.`;
    case "html_response":
      return `${noun} returned an HTML page instead of API JSON (HTTP ${d.status}). Check that the base URL points at the API root (e.g. https://host/v1) and not the provider's website.`;
    case "invalid_credentials":
      return `API key rejected by ${noun.toLowerCase()} (HTTP 401)${detail ? `: ${detail}` : ""}`;
    case "access_denied":
      // Only blame the credential when the body actually talks about the key.
      // "Forbidden: requests from this network are blocked" is an IP/network
      // block, and must not be reported as a key problem.
      if (CREDENTIAL_WORDS.test(detail)) {
        return `API key rejected by ${noun.toLowerCase()} (HTTP 403)${detail ? `: ${detail}` : ""}`;
      }
      return `${noun} denied access (HTTP 403); this does not prove the API key is invalid.${detail ? ` Upstream said: ${detail}` : ""}`;
    case "wrong_endpoint":
      return `${noun} endpoint not found (HTTP 404). Check the configured base URL and API type.`;
    case "method_not_allowed":
      return `${noun} does not allow this HTTP method (HTTP 405). Check the API type (chat vs responses).`;
    case "rate_limited":
      return `${noun} rate limited the request (HTTP 429). Wait and retry, or check quota.`;
    case "upstream_server_error":
      return `${noun} server failed (HTTP ${d.status}). This is an upstream outage, not an API key problem.`;
    case "malformed_response":
      return `${noun} returned HTTP ${d.status} but the body was not usable JSON.${detail ? `: ${detail}` : ""}`;
    default:
      return `${noun} request failed (HTTP ${d.status}).${detail ? `: ${detail}` : ""}`;
  }
}

/**
 * Decide whether a diagnostic proves the credential is bad. Used so that a 403
 * challenge page can never be reported as an invalid key.
 */
/**
 * Words that mean "the upstream is talking about the credential".
 *
 * `forbidden` is deliberately NOT here: providers routinely use it for network
 * and IP blocks ("Forbidden: requests from this network are blocked"), and
 * treating that as a key failure is the exact misdiagnosis being fixed.
 */
const CREDENTIAL_WORDS = /api[\s_-]?key|unauthori[sz]ed|authentication|invalid or revoked|bad credential|token (?:is )?(?:invalid|expired|revoked)/i;

/**
 * True when the failure is a network/reachability problem, not a credential one.
 */
export function isCredentialFailure(d) {
  if (d.category === "invalid_credentials") return true;
  if (d.category === "access_denied") {
    return CREDENTIAL_WORDS.test(d.detail || "");
  }
  return false;
}