// Provider connectivity layer — the single place that knows how to turn a
// configured provider into an outbound request, and how to read the answer.
//
// WHY THIS EXISTS
// 9Router grew four independent implementations of "talk to an
// OpenAI-compatible provider", and each one made its own mistakes:
//
//   validation   routes/provider-nodes/validate, routes/providers/validate
//   saved conn   routes/providers/[id]/test/testUtils.js
//   runtime      open-sse/executors/default.js  (buildUrl / buildHeaders)
//   embeddings   open-sse/handlers/embeddingProviders/openaiCompatNode.js
//
// They disagreed on which base URL to use, on auth headers, on timeouts, and on
// how to classify a failure. The visible symptom was a provider that validated
// fine in one place and failed in another, with the failure mislabelled as an
// invalid API key.
//
// This module owns:
//   • endpoint construction      → describeProviderTarget()
//   • auth headers               → authHeadersFor()
//   • timeout + redirect policy  → providerFetch()
//   • one failure taxonomy       → classifyUpstreamResponse()
//   • redaction                  → never returns a credential
//
// It is pure except for `providerFetch`, so it is testable without a network.

// ─── Failure taxonomy ────────────────────────────────────────────────────────
// One vocabulary, used by every caller. `invalid_credentials` is the ONLY
// category that means "the key is wrong", and it is reached only when the
// upstream body actually talks about the credential.
export const FAILURE_CATEGORY = Object.freeze({
  INVALID_CREDENTIALS: "invalid_credentials",
  PERMISSION_DENIED: "permission_denied",
  SECURITY_CHALLENGE: "security_challenge",
  RATE_LIMITED: "rate_limited",
  UPSTREAM_SERVER_ERROR: "upstream_server_error",
  INVALID_ENDPOINT: "invalid_endpoint",
  NETWORK_ERROR: "network_error",
  DNS_ERROR: "dns_error",
  TLS_ERROR: "tls_error",
  TIMEOUT: "timeout",
  INVALID_RESPONSE: "invalid_response",
  UNSUPPORTED_OPERATION: "unsupported_operation",
});

/** Categories that mean the credential itself was rejected. */
const CREDENTIAL_FAILURE = new Set([FAILURE_CATEGORY.INVALID_CREDENTIALS]);

const HTML_BODY = /^\s*(<!doctype\s+html|<html[\s>])/i;
const HTML_CONTENT_TYPE = /text\/html|application\/xhtml\+xml/i;
// Cloudflare/edge-challenge fingerprints. Detection only — 9Router never
// attempts to solve, spoof around, or otherwise evade a challenge.
const EDGE_CHALLENGE = /cloudflare|cf-ray|attention required|checking your browser|just a moment|enable javascript and cookies|ie6 oldie|captcha|__cf_chl/i;
// An edge *challenge* is a 403/503 (or 429 in rare configs). Rate limiting is a
// 429 and is deliberately excluded here: Cloudflare error 1015 ("rate limited")
// is plain text, not a challenge, and calling it one sends the operator to hunt
// for an IP block that does not exist.
const CHALLENGE_STATUSES = new Set([401, 403, 503]);

/**
 * Words that mean the upstream is talking about the credential.
 *
 * `forbidden` is deliberately absent: providers routinely use it for network
 * and IP blocks ("Forbidden: requests from this network are blocked"), and
 * reading that as a bad key is the exact misdiagnosis this module prevents.
 */
const CREDENTIAL_WORDS = /\bapi[\s_-]?key\b|\bapikey\b|unauthori[sz]ed|authentication|invalid or revoked|bad credential|token (?:is )?(?:invalid|expired|revoked)|missing api key/i;

// ─── Redaction ───────────────────────────────────────────────────────────────

/**
 * Strip scripts/styles/tags and collapse whitespace.
 *
 * @param {string} text
 * @param {number} [limit]
 * @returns {string} markup-free text, never `undefined`
 */
export function sanitizeUpstreamText(text, limit = 200) {
  return String(text ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

/**
 * Remove anything credential-shaped from a string bound for a log, an HTTP
 * response, or the database.
 *
 * Covers four leak paths observed in the field:
 *   1. `Authorization: Bearer <key>` echoed by a reverse proxy
 *   2. a provider echoing the raw key back in its error message
 *   3. `api_key=<key>` style query strings
 *   4. provider-specific key prefixes (`cc_`, `sk-`, …)
 *
 * @param {string} text
 * @param {string} [apiKey] the credential actually in use, when known
 */
export function redactSecrets(text, apiKey = "") {
  let out = String(text ?? "")
    .replace(/Bearer\s+[^\s"'<>,;]+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|access[_-]?token|token|secret|password)(\s*[=:]\s*)["']?[^\s,;"'&]+/gi, "$1$2[redacted]")
    // Key-shaped tokens. Consume to end-of-token so nothing of the secret
    // survives: `sk-proj-ABCDEF123456` must not reduce to `sk-proj-ABCDEF12345_`.
    .replace(/\b(?:sk|pk|cc|api|key|ghp|xox[abprs])[-_][A-Za-z0-9][A-Za-z0-9_-]{7,}/gi, (m) => {
      const sep = m.search(/[-_]/);
      return `${m.slice(0, sep)}_[redacted]`;
    });
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  // Only worth doing for keys long enough not to be a false positive.
  if (key.length >= 8) out = out.split(key).join("[redacted]");
  return out.trim();
}

// ─── Endpoint description ────────────────────────────────────────────────────

const COMPATIBLE_PREFIXES = {
  openai: "openai-compatible-",
  anthropic: "anthropic-compatible-",
  embedding: "custom-embedding-",
};

/** Map a provider/node id to its compatibility family, or null for built-ins. */
export function compatibleFamily(providerId = "") {
  const id = String(providerId || "");
  if (id.startsWith(COMPATIBLE_PREFIXES.embedding)) return "embedding";
  if (id.startsWith(COMPATIBLE_PREFIXES.anthropic)) return "anthropic";
  if (id.startsWith(COMPATIBLE_PREFIXES.openai)) return "openai";
  return null;
}

/**
 * Build the endpoint map for a configured provider.
 *
 * Accepts a base URL in any form a user might paste (`https://host`,
 * `https://host/v1`, `https://host/v1/chat/completions`) and normalizes once,
 * centrally. Never appends `/v1`: self-hosted gateways legitimately live at the
 * root, and the version segment is the user's decision.
 *
 * @param {object} input
 * @param {string} input.providerId  node id, e.g. `openai-compatible-chat-<uuid>`
 * @param {string} [input.baseUrl]
 * @param {string} [input.apiKey]
 * @returns {{family: string|null, baseUrl: string, apiType: string,
 *            authScheme: string, urls: Record<string,string>,
 *            headers: Record<string,string>, error?: string}}
 */
export function describeProviderTarget({ providerId = "", baseUrl = "", apiKey = "" } = {}) {
  const family = compatibleFamily(providerId);
  const normalizedBase = normalizeCompatibleBase(baseUrl);
  const key = typeof apiKey === "string" ? apiKey.trim() : "";

  if (!normalizedBase) {
    return {
      family,
      baseUrl: "",
      apiType: "chat",
      authScheme: family === "anthropic" ? "x-api-key" : "bearer",
      urls: {},
      headers: {},
      error: "Base URL is missing or invalid. Use an absolute http(s) API base URL.",
    };
  }

  // The api type lives in the node id: `openai-compatible-responses-<uuid>`.
  const apiType = /-responses-/.test(String(providerId)) ? "responses" : "chat";

  const urls =
    family === "anthropic"
      ? { models: `${normalizedBase}/models`, chat: `${normalizedBase}/messages`, embeddings: `${normalizedBase}/embeddings` }
      : family === "embedding"
        ? { models: `${normalizedBase}/models`, embeddings: `${normalizedBase}/embeddings` }
        : apiType === "responses"
          ? { models: `${normalizedBase}/models`, chat: `${normalizedBase}/responses` }
          : { models: `${normalizedBase}/models`, chat: `${normalizedBase}/chat/completions` };

  const authScheme = family === "anthropic" ? "x-api-key" : "bearer";

  return {
    family,
    baseUrl: normalizedBase,
    apiType,
    authScheme,
    urls,
    headers: authHeadersFor({ family, apiKey: key }),
  };
}

/**
 * Build auth headers for a compatible provider.
 *
 * The key is optional: self-hosted gateways frequently run unauthenticated, and
 * sending `Authorization: Bearer ` (empty) is rejected by some gateways while
 * leaking into error text on others. So the header is omitted entirely.
 *
 * @returns {Record<string,string>}
 */
export function authHeadersFor({ family = "openai", apiKey = "", extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return headers;

  if (family === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    // Some Anthropic-compatible gateways also expect a bearer token.
    headers.Authorization = `Bearer ${key}`;
    return headers;
  }
  headers.Authorization = `Bearer ${key}`;
  return headers;
}

/**
 * Normalize a user-supplied base URL.
 *
 * - trims whitespace and trailing slashes
 * - strips a pasted endpoint suffix, repeatedly (`.../v1/chat/completions`)
 * - removes embedded credentials (they must never reach logs or error text)
 * - adds `https://` to a bare host
 * - rejects anything that is not http(s)
 *
 * @param {string} raw
 * @returns {string} normalized base, or `""` when unusable
 */
const ENDPOINT_SUFFIXES = [
  "/chat/completions",
  "/completions",
  "/responses",
  "/models",
  "/messages",
  "/embeddings",
  "/v1/models",
];

export function normalizeCompatibleBase(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return "";
  if (!/^https?:\/\//i.test(value)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value)) value = `https://${value}`;
    else return "";
  }
  // Strip userinfo entirely — credentials must never travel inside a base URL.
  value = value.replace(/^(https?:\/\/)[^/@]*@/i, "$1");

  let changed = true;
  while (changed) {
    changed = false;
    const trimmed = value.replace(/\/+$/, "");
    for (const suffix of ENDPOINT_SUFFIXES) {
      if (trimmed.toLowerCase().endsWith(suffix)) {
        value = trimmed.slice(0, trimmed.length - suffix.length).replace(/\/+$/, "");
        changed = true;
        break;
      }
    }
    if (!changed) value = trimmed;
  }
  return value;
}

// ─── Outbound request ────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Perform one upstream request with a hard deadline and a redirect policy.
 *
 * `redirect: "manual"` is deliberate. Following a redirect would let an
 * upstream silently move the request — and its Authorization header — to a
 * host the operator never configured, and it hides the real final URL. We
 * surface the `Location` instead so the operator can see it.
 *
 * @param {string} url
 * @param {RequestInit & {timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<Response>}
 */
export async function providerFetch(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    fetchImpl,
    ...rest
  } = options;

  // A real `AbortSignal.timeout()` is deliberately unref'd, so it does not keep
  // the event loop alive on its own. Combined with a caller-supplied fetch that
  // holds no socket, a stalled request could let the process exit before the
  // deadline fires. Use an explicit controller + ref'd timer so the deadline is
  // guaranteed to fire and the process cannot exit mid-request.
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(Object.assign(new Error(`Upstream request timed out after ${timeoutMs}ms`), { name: "TimeoutError" }));
  }, timeoutMs);

  const onCallerAbort = () => {
    controller.abort(signal?.reason);
  };
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const doFetch = fetchImpl || globalThis.fetch;
  try {
    return await doFetch(url, {
      ...rest,
      signal: controller.signal,
      redirect: rest.redirect ?? "manual",
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onCallerAbort);
  }
}

// ─── Response classification ─────────────────────────────────────────────────

/**
 * Classify an upstream HTTP response.
 *
 * Ordering matters and is the whole point of this function:
 *   1. an HTML body is classified by its *content* (edge challenge vs a
 *      provider website), never by status alone;
 *   2. a redirect is reported as such instead of being followed;
 *   3. only then is the status mapped, with 401 vs 403 separated;
 *   4. a 403 is only a credential failure when the body says so.
 *
 * @param {Response} response
 * @param {{url?: string, method?: string, hasAuth?: boolean, apiKey?: string}} [request]
 * @returns {Promise<object>} diagnostic
 */
export async function classifyUpstreamResponse(response, request = {}) {
  const status = response?.status ?? null;
  const contentType = response?.headers?.get?.("content-type") || "";
  const text = await readBodySafely(response);
  const preview = redactSecrets(sanitizeUpstreamText(text), request.apiKey);
  const detail = redactSecrets(sanitizeUpstreamText(extractMessage(text), 240), request.apiKey);

  const serverHeader = response?.headers?.get?.("server") || "";
  const cfMitigated = response?.headers?.get?.("cf-mitigated") || "";
  const looksHtml = HTML_CONTENT_TYPE.test(contentType) || HTML_BODY.test(text);
  const isRedirect = status >= 300 && status < 400 && Boolean(response?.headers?.get?.("location"));

  let category;
  let isCredentialFailure = false;

  if (isRedirect) {
    // Not followed (see providerFetch). Report the destination, never follow.
    category = FAILURE_CATEGORY.INVALID_ENDPOINT;
  } else if (status === 429) {
    // Checked before any challenge detection: a 429 from an edge is rate
    // limiting (Cloudflare 1015), not an interactive challenge.
    category = FAILURE_CATEGORY.RATE_LIMITED;
  } else if (looksHtml) {
    category = EDGE_CHALLENGE.test(`${text} ${serverHeader} ${cfMitigated}`) && CHALLENGE_STATUSES.has(status)
      ? FAILURE_CATEGORY.SECURITY_CHALLENGE
      : FAILURE_CATEGORY.INVALID_ENDPOINT;
  } else if (status === 401) {
    category = FAILURE_CATEGORY.INVALID_CREDENTIALS;
    isCredentialFailure = true;
  } else if (status === 403) {
    // A 403 is a credential failure only when the body is about the credential.
    isCredentialFailure = CREDENTIAL_WORDS.test(detail);
    category = isCredentialFailure
      ? FAILURE_CATEGORY.INVALID_CREDENTIALS
      : FAILURE_CATEGORY.PERMISSION_DENIED;
  } else if (status === 404 || status === 405) {
    category = FAILURE_CATEGORY.INVALID_ENDPOINT;
  } else if (status >= 500) {
    category = FAILURE_CATEGORY.UPSTREAM_SERVER_ERROR;
  } else if (status >= 400) {
    category = FAILURE_CATEGORY.INVALID_RESPONSE;
  } else {
    category = FAILURE_CATEGORY.INVALID_RESPONSE;
  }

  return {
    ok: Boolean(response?.ok),
    status,
    category,
    isCredentialFailure,
    contentType,
    /**
     * Raw body, INTERNAL ONLY.
     *
     * Callers need it to inspect a payload (e.g. pull model ids out of a
     * catalog) after classification has consumed the stream. It is never
     * included in an HTTP response or a log — `publicDiagnostic()` is what
     * reaches a client.
     */
    text,
    /** Parsed JSON when the body was JSON, else null. INTERNAL ONLY. */
    json: safeJsonParse(text),
    // A 2xx that is not JSON is a broken endpoint, not a working one.
    parsed: isProbablyJson(text),
    preview,
    detail,
    finalUrl: response?.url || request.url || "",
    redirected: isRedirect,
    location: response?.headers?.get?.("location") || "",
    request: {
      method: request.method || "GET",
      url: request.url || "",
      // Presence only. The credential is never recorded.
      auth: request.hasAuth ? "present" : "none",
    },
    diagnostics: diagnosticHeaders(response),
  };
}

/** Headers worth returning: they identify which hop answered. */
const DIAGNOSTIC_HEADER_NAMES = [
  "server",
  "cf-ray",
  "cf-mitigated",
  "via",
  "x-cache",
  "location",
  "x-request-id",
  "retry-after",
];

function diagnosticHeaders(response) {
  const out = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = response?.headers?.get?.(name);
    if (value) out[name] = String(value).slice(0, 200);
  }
  return out;
}

/**
 * Read a body exactly once, as text. Never throws — a stream that was already
 * consumed elsewhere must not turn a classification into a 500.
 */
async function readBodySafely(response) {
  if (!response || typeof response.text !== "function") return "";
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function isProbablyJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (!/^[[{"]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function safeJsonParse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || !/^[[{"]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * The subset of a diagnostic that is safe to send to a browser.
 * Excludes `text`/`json`, which may contain provider-internal data.
 *
 * @param {object} diagnostic
 */
export function publicDiagnostic(diagnostic) {
  if (!diagnostic) return null;
  const {
    ok, status, category, isCredentialFailure, contentType, parsed,
    preview, detail, finalUrl, redirected, location, request, diagnostics,
  } = diagnostic;
  return {
    ok, status, category, isCredentialFailure, contentType, parsed,
    preview, detail, finalUrl, redirected, location, request, diagnostics,
  };
}

/** Best-effort human-readable message from an upstream body. */
function extractMessage(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const data = JSON.parse(raw);
    return String(
      data?.error?.message
        || (typeof data?.error === "string" ? data.error : "")
        || data?.message
        || data?.msg
        || data?.detail
        || ""
    );
  } catch {
    return raw;
  }
}

/** Read a body as JSON without ever throwing. Already in httpBody.js. */
export { readResponseOnce, parseErrorPayload, describeNonJsonBody } from "./httpBody.js";

// ─── Remediation ─────────────────────────────────────────────────────────────

const REMEDIATION = {
  [FAILURE_CATEGORY.INVALID_CREDENTIALS]:
    "The provider rejected the credential. Re-enter the API key for this connection and confirm it is active on the provider's dashboard.",
  [FAILURE_CATEGORY.PERMISSION_DENIED]:
    "The provider refused the request without naming a credential problem. Check account permissions, plan/quota, and whether your server's outbound IP is allowed.",
  [FAILURE_CATEGORY.SECURITY_CHALLENGE]:
    "The provider's edge (Cloudflare or similar) served an interactive challenge to this server. 9Router will not attempt to bypass it. Ask the provider to allowlist this host's outbound IP, or use a supported API endpoint.",
  [FAILURE_CATEGORY.RATE_LIMITED]:
    "The provider is rate limiting this host. Wait before retrying and check the account's quota and concurrency limits.",
  [FAILURE_CATEGORY.UPSTREAM_SERVER_ERROR]:
    "The provider's own servers failed. This is an upstream outage, not a configuration problem — retry later.",
  [FAILURE_CATEGORY.INVALID_ENDPOINT]:
    "The base URL does not resolve to an OpenAI-compatible API. Confirm the API root (commonly ending in /v1) and that the path is not the provider's website.",
  [FAILURE_CATEGORY.DNS_ERROR]:
    "The provider hostname could not be resolved. Check the base URL spelling and this server's DNS.",
  [FAILURE_CATEGORY.TLS_ERROR]:
    "TLS/certificate validation failed for the provider host. Check the certificate chain and system clock on this host.",
  [FAILURE_CATEGORY.TIMEOUT]:
    "The provider did not answer within the timeout. Check provider availability, egress filtering, and any configured proxy.",
  [FAILURE_CATEGORY.INVALID_RESPONSE]:
    "The provider answered with a body this client cannot use. Confirm the API type (chat vs responses) and the endpoint path.",
  [FAILURE_CATEGORY.UNSUPPORTED_OPERATION]:
    "This provider does not implement the requested operation. Use a different endpoint or provider.",
  [FAILURE_CATEGORY.NETWORK_ERROR]:
    "This server could not reach the provider. Check outbound network access, firewall rules, and any configured proxy.",
};

/**
 * Turn a diagnostic into a message plus a concrete next step.
 *
 * @param {object} diagnostic result of classifyUpstreamResponse()
 * @param {{noun?: string}} [options]
 */
export function describeFailure(diagnostic, { noun = "The provider" } = {}) {
  const { category, status, detail, preview } = diagnostic || {};
  const statusPart = status ? ` (HTTP ${status})` : "";

  let headline;
  switch (category) {
    case FAILURE_CATEGORY.INVALID_CREDENTIALS:
      headline = `${noun} rejected the API key${statusPart}.`;
      break;
    case FAILURE_CATEGORY.PERMISSION_DENIED:
      headline = `${noun} denied access${statusPart} without identifying a credential problem.`;
      break;
    case FAILURE_CATEGORY.SECURITY_CHALLENGE:
      headline = `${noun}'s edge served an interactive security challenge${statusPart}.`;
      break;
    case FAILURE_CATEGORY.RATE_LIMITED:
      headline = `${noun} is rate limiting this host${statusPart}.`;
      break;
    case FAILURE_CATEGORY.UPSTREAM_SERVER_ERROR:
      headline = `${noun}'s servers failed${statusPart}.`;
      break;
    case FAILURE_CATEGORY.INVALID_ENDPOINT:
      headline = `${noun} did not answer as an OpenAI-compatible API${statusPart}.`;
      break;
    case FAILURE_CATEGORY.DNS_ERROR:
      headline = `${noun}'s hostname could not be resolved.`;
      break;
    case FAILURE_CATEGORY.TLS_ERROR:
      headline = `${noun}'s TLS certificate could not be validated.`;
      break;
    case FAILURE_CATEGORY.TIMEOUT:
      headline = `${noun} timed out.`;
      break;
    case FAILURE_CATEGORY.NETWORK_ERROR:
      headline = `${noun} could not be reached.`;
      break;
    case FAILURE_CATEGORY.UNSUPPORTED_OPERATION:
      headline = `${noun} does not support this operation.`;
      break;
    default:
      headline = `${noun} returned an unusable response${statusPart}.`;
  }

  const evidence = detail || preview;
  const parts = [headline];
  if (evidence) parts.push(`Upstream said: ${evidence}`);
  parts.push(REMEDIATION[category] || "Review the base URL and provider status page.");
  return parts.join(" ");
}

/** The remediation sentence alone, for compact UI placement. */
export function remediationFor(category) {
  return REMEDIATION[category] || "Review the base URL and provider status page.";
}

/** True only for a genuine credential rejection. */
export function isCredentialFailure(diagnostic) {
  return CREDENTIAL_FAILURE.has(diagnostic?.category) || diagnostic?.isCredentialFailure === true;
}

/** Categories that indicate the host could not complete the request at all. */
export const NETWORK_CATEGORIES = new Set([
  FAILURE_CATEGORY.NETWORK_ERROR,
  FAILURE_CATEGORY.DNS_ERROR,
  FAILURE_CATEGORY.TLS_ERROR,
  FAILURE_CATEGORY.TIMEOUT,
]);

// ─── Network failure classification ──────────────────────────────────────────

const NETWORK_CODE_MAP = Object.freeze({
  ENOTFOUND: FAILURE_CATEGORY.DNS_ERROR,
  EAI_AGAIN: FAILURE_CATEGORY.DNS_ERROR,
  ETIMEDOUT: FAILURE_CATEGORY.TIMEOUT,
  ESOCKETTIMEDOUT: FAILURE_CATEGORY.TIMEOUT,
  ERR_SOCKET_CONNECTION_TIMEOUT: FAILURE_CATEGORY.TIMEOUT,
  UND_ERR_CONNECT_TIMEOUT: FAILURE_CATEGORY.TIMEOUT,
  UND_ERR_HEADERS_TIMEOUT: FAILURE_CATEGORY.TIMEOUT,
  UND_ERR_BODY_TIMEOUT: FAILURE_CATEGORY.TIMEOUT,
  ECONNREFUSED: FAILURE_CATEGORY.NETWORK_ERROR,
  ECONNRESET: FAILURE_CATEGORY.NETWORK_ERROR,
  EPIPE: FAILURE_CATEGORY.NETWORK_ERROR,
  EHOSTUNREACH: FAILURE_CATEGORY.NETWORK_ERROR,
  ENETUNREACH: FAILURE_CATEGORY.NETWORK_ERROR,
  EPROTO: FAILURE_CATEGORY.TLS_ERROR,
  CERT_HAS_EXPIRED: FAILURE_CATEGORY.TLS_ERROR,
  DEPTH_ZERO_SELF_SIGNED_CERT: FAILURE_CATEGORY.TLS_ERROR,
  SELF_SIGNED_CERT_IN_CHAIN: FAILURE_CATEGORY.TLS_ERROR,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: FAILURE_CATEGORY.TLS_ERROR,
  ERR_TLS_CERT_ALTNAME_INVALID: FAILURE_CATEGORY.TLS_ERROR,
});

/**
 * Classify a thrown transport error.
 *
 * Walks the `cause` chain because undici wraps the real syscall error in a
 * generic `Error: fetch failed` that carries no code of its own.
 *
 * @param {unknown} error
 * @returns {string} a FAILURE_CATEGORY value
 */
export function classifyNetworkFailure(error) {
  if (!error) return FAILURE_CATEGORY.NETWORK_ERROR;

  const seen = new Set();
  let current = error;
  let sawTimeoutName = false;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current.name === "TimeoutError") sawTimeoutName = true;
    if (typeof current.name === "string" && NETWORK_CODE_MAP[current.name]) return NETWORK_CODE_MAP[current.name];

    const code = current.code || current.errno;
    if (code && NETWORK_CODE_MAP[code]) return NETWORK_CODE_MAP[code];

    const message = String(current.message || "");
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) return FAILURE_CATEGORY.TIMEOUT;
    if (/certificate|self.signed|SSL|TLS/i.test(message)) return FAILURE_CATEGORY.TLS_ERROR;
    if (/getaddrinfo|ENOTFOUND/i.test(message)) return FAILURE_CATEGORY.DNS_ERROR;

    current = current.cause;
  }

  if (sawTimeoutName) return FAILURE_CATEGORY.TIMEOUT;
  if (error.name === "AbortError") return FAILURE_CATEGORY.TIMEOUT;
  return FAILURE_CATEGORY.NETWORK_ERROR;
}

/** Build the standard failure payload for a thrown transport error. */
export function networkFailureDiagnostic(error, request = {}) {
  const category = classifyNetworkFailure(error);
  return {
    ok: false,
    status: null,
    category,
    isCredentialFailure: false,
    contentType: "",
    parsed: false,
    preview: "",
    // Only the error's own class name and message, never a URL with a key in it.
    detail: redactSecrets(sanitizeUpstreamText(error?.message || "", 200), request.apiKey),
    finalUrl: request.url || "",
    redirected: false,
    location: "",
    request: {
      method: request.method || "GET",
      url: request.url || "",
      auth: request.hasAuth ? "present" : "none",
    },
    diagnostics: {},
  };
}