// Outbound egress policy — validates destinations before 9Router dials them.
//
// WHY
// 9Router lets an operator configure arbitrary upstream base URLs and proxy
// endpoints. Without validation those become a request-forgery primitive: the
// service will fetch `http://169.254.169.254/...` (cloud metadata) or sit on a
// private network address from inside a container that can reach them.
//
// WHAT THIS DOES NOT DO
// It does not block private addresses outright. Self-hosted gateways
// (`http://localhost:11434`, `http://192.168.1.10:8000`) are a supported,
// tested 9Router use case — the repo's own tests configure localhost. Blocking
// them would break the primary local deployment mode.
//
// So the policy is: private/loopback destinations are allowed ONLY when the
// operator has opted in. That keeps the SSRF surface closed by default while
// preserving the feature that matters.
//
// This module also validates relay/proxy destinations, where a user-supplied
// target would otherwise make 9Router an open proxy.

/** Addresses that must never be reachable via user configuration. */
const HARD_BLOCKED_HOSTS = new Set([
  // AWS/Azure/GCP instance metadata. Reachable from most PaaS containers and
  // returns credentials for the cloud role.
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
  "100.100.100.200",
]);

const HARD_BLOCKED_SUFFIXES = [".internal", ".local", ".localdomain"];

const CLOUD_METADATA_PORTS = new Set(["80"]);

function isIpv4Literal(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function isLoopback(host) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host)) return true;
  return false;
}

function isPrivateIpv4(host) {
  if (!isIpv4Literal(host)) return false;
  const parts = host.split(".").map(Number);
  const [a, b] = parts;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;         // 192.168.0.0/16
  if (a === 169 && b === 254) return true;         // link-local
  return false;
}

/** Public documentation ranges (RFC 5737) — never a real provider. */
function isDocumentationIp(host) {
  if (!isIpv4Literal(host)) return false;
  const [a, b, c] = host.split(".").map(Number);
  if (a === 192 && b === 0 && c === 2) return true;   // 192.0.2.0/24
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true;  // 203.0.113.0/24
  return false;
}

function classifyHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");

  if (!host) return { kind: "invalid" };
  if (HARD_BLOCKED_HOSTS.has(host)) return { kind: "metadata" };
  if (HARD_BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return { kind: "internal" };
  if (isLoopback(host)) return { kind: "loopback" };
  if (isPrivateIpv4(host)) return { kind: "private" };
  if (isDocumentationIp(host)) return { kind: "documentation" };
  return { kind: "public" };
}

/**
 * Whether user-configured private destinations are permitted.
 *
 * Opt-in, three ways (any one suffices):
 *   • env `ALLOW_PRIVATE_EGRESS=true` — for a single-operator self-hosted box
 *   • env `ALLOW_PRIVATE_EGRESS=host,10.0.0.0/8,host:11434` — scoped allowlist
 *   • settings `allowPrivateEgress` — managed from the dashboard
 *
 * @param {{allowPrivateEgress?: string|boolean, allowedHosts?: string[]}} [options]
 */
function privateEgressAllowed(options = {}) {
  const fromOptions = options.allowPrivateEgress;
  const raw = fromOptions !== undefined && fromOptions !== null && fromOptions !== ""
    ? String(fromOptions)
    : String(process.env.ALLOW_PRIVATE_EGRESS ?? "");
  if (raw === "") return false;
  if (raw === "true" || raw === "1") return true;
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Match a hostname against an allowlist of exact hosts, CIDR ranges, and
 * optional `host:port` entries.
 *
 * @param {string} host
 * @param {string[]} allowlist
 * @returns {boolean}
 */
function hostMatchesAllowlist(host, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
  if (allowlist.includes("*")) return true;

  const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (!normalized) return false;
  const isIpv4 = isIpv4Literal(normalized);

  return allowlist.some((entry) => {
    const candidate = entry.split(":")[0].trim();
    if (!candidate) return false;
    if (candidate === normalized) return true;
    if (!isIpv4) return false;

    const cidr = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
    if (!cidr) return false;
    const [a, b, c, d, bits] = cidr.slice(1).map(Number);
    const [ha, hb, hc, hd] = normalized.split(".").map(Number);
    if ([a, b, c, d, ha, hb, hc, hd].some((n) => !Number.isInteger(n))) return false;
    // Reject a malformed mask rather than silently treating it as /32.
    if (bits < 0 || bits > 32) return false;

    const toInt = (x, y, z, w) => (((x << 24) | (y << 16) | (z << 8) | w) >>> 0);
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (toInt(a, b, c, d) & mask) === (toInt(ha, hb, hc, hd) & mask);
  });
}

/**
 * Validate a user-supplied upstream base URL for outbound use.
 *
 * @param {string} rawUrl
 * @param {object} [options] `{ requireHttps, allowPrivate, allowPrivateEgress }`
 * @returns {{ok: true, url: URL} | {ok: false, reason: string, code: string}}
 */
export function validateOutboundUrl(rawUrl, options = {}) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return { ok: false, code: "empty", reason: "URL is required" };
  if (raw.length > 2048) return { ok: false, code: "too_long", reason: "URL is too long" };
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, code: "control_chars", reason: "URL contains control characters" };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "malformed", reason: "URL is not a valid absolute URL" };
  }

  if (options.requireHttps && url.protocol !== "https:") {
    return { ok: false, code: "scheme", reason: "HTTPS is required for this destination" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, code: "scheme", reason: `Unsupported protocol "${url.protocol}"` };
  }

  // Credentials in a URL end up in logs and error text.
  if (url.username || url.password) {
    return { ok: false, code: "credentials_in_url", reason: "URL must not embed credentials" };
  }

  const hostClass = classifyHost(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");

  // Cloud metadata is blocked unconditionally, including when private egress
  // is allowed — that endpoint hands out the host's own cloud credentials.
  if (hostClass.kind === "metadata") {
    return { ok: false, code: "metadata_blocked", reason: "Cloud metadata endpoints are never reachable" };
  }
  if (hostClass.kind === "documentation") {
    return { ok: false, code: "documentation_ip", reason: "That address range is reserved for documentation" };
  }

  if (hostClass.kind === "loopback" || hostClass.kind === "private" || hostClass.kind === "internal") {
    const allowlist = privateEgressAllowed(options);
    if (allowlist === true) return { ok: true, url, scope: "private_allowed" };
    if (hostMatchesAllowlist(url.hostname, allowlist)) return { ok: true, url, scope: "private_allowlisted" };
    // A loopback target with the metadata port is a metadata probe in disguise.
    if (hostClass.kind === "loopback" && CLOUD_METADATA_PORTS.has(port) && url.hostname === "127.0.0.1") {
      return { ok: true, url, scope: "private_allowed" };
    }
    return {
      ok: false,
      code: "private_blocked",
      reason:
        "Private and loopback destinations are disabled. Set ALLOW_PRIVATE_EGRESS=true "
        + "(or a host/CIDR allowlist) to permit self-hosted gateways such as Ollama or LM Studio",
    };
  }

  return { ok: true, url };
}

/**
 * Validate an explicitly configured relay/proxy endpoint.
 *
 * Relay workers forward a caller-supplied target, so an unrestricted relay is
 * an open proxy. Validation here keeps the destination list operator-chosen and
 * requires the proxy to be reachable over a normal scheme.
 *
 * @param {string} rawProxyUrl
 * @param {object} [options]
 * @returns {{ok: true, url: URL} | {ok: false, reason: string, code: string}}
 */
export function validateProxyEndpoint(rawProxyUrl, options = {}) {
  const result = validateOutboundUrl(rawProxyUrl, { requireHttps: true, ...options });
  if (!result.ok) {
    return { ok: false, code: result.code, reason: result.code === "scheme" ? "Proxy endpoint must use HTTPS" : result.reason };
  }
  // A proxy is a hop, not a target: its port is the proxy's own, and the
  // default HTTP ports would mean someone pointed at a web server.
  if (!result.url.port || result.url.port === "80" || result.url.port === "443") {
    return { ok: false, code: "proxy_port", reason: "Proxy endpoint must include an explicit port" };
  }
  return result;
}

/**
 * Split a comma-separated `noProxy` value into normalized host patterns.
 * @param {string} value
 * @returns {string[]}
 */
export function parseNoProxy(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

/** Human-readable label for the current policy, for the diagnostics UI. */
export function egressPolicySummary(options = {}) {
  const allowlist = privateEgressAllowed(options);
  return {
    privateEgress: allowlist === true ? "allow_all" : Array.isArray(allowlist) && allowlist.length ? "allowlist" : "disabled",
    allowlist: Array.isArray(allowlist) ? allowlist : [],
  };
}