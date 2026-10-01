// Network-layer failure classification, shared by provider validation paths.
//
// A DNS miss, TLS rejection, refused connection or timeout is a *reachability*
// problem. Collapsing these into "Invalid API key" (which several call sites
// used to do) sends the user hunting for a credential that was never even sent.
// These helpers keep the two failure classes distinct.

const NETWORK_CODES = {
  ENOTFOUND: "dns_failure",
  EAI_AGAIN: "dns_failure",
  // Node surfaces connect/read timeouts as these on the socket error itself.
  ETIMEDOUT: "timeout",
  ESOCKETTIMEDOUT: "timeout",
  ERR_SOCKET_CONNECTION_TIMEOUT: "timeout",
  ECONNREFUSED: "connection_refused",
  ECONNRESET: "connection_reset",
  EHOSTUNREACH: "host_unreachable",
  ENETUNREACH: "network_unreachable",
  EPIPE: "connection_reset",
  EPROTO: "tls_failure",
  CERT_HAS_EXPIRED: "tls_failure",
  DEPTH_ZERO_SELF_SIGNED_CERT: "tls_failure",
  SELF_SIGNED_CERT_IN_CHAIN: "tls_failure",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "tls_failure",
  ERR_TLS_CERT_ALTNAME_INVALID: "tls_failure",
};

/**
 * @param {unknown} error
 * @returns {string} one of the NETWORK_CODES values, or "timeout" / "network_error"
 */
export function classifyNetworkFailure(error) {
  if (!error) return "network_error";

  // Walk the cause chain first: undici wraps the real syscall error, and the
  // wrapper itself is a generic "fetch failed" with no code. The outermost
  // error's `name` is checked only after its causes, otherwise every undici
  // timeout would be misread from the generic wrapper.
  const seen = new Set();
  let current = error;
  let sawTimeoutByName = false;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current.name === "TimeoutError") sawTimeoutByName = true;
    if (typeof current.name === "string" && NETWORK_CODES[current.name]) {
      return NETWORK_CODES[current.name];
    }
    const code = current.code || current.errno;
    if (code && NETWORK_CODES[code]) return NETWORK_CODES[code];
    if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
      return "timeout";
    }
    const message = String(current.message || "");
    if (/timeout|timed out|ETIMEDOUT/i.test(message)) return "timeout";
    if (/certificate|SSL|TLS/i.test(message)) return "tls_failure";
    if (/getaddrinfo/i.test(message)) return "dns_failure";
    current = current.cause;
  }
  if (sawTimeoutByName) return "timeout";
  if (error.name === "AbortError") return "timeout";
  return "network_error";
}

const MESSAGES = {
  timeout: (noun) => `${noun} timed out. The upstream did not answer in time.`,
  dns_failure: (noun) => `${noun} hostname could not be resolved (DNS). Check the base URL and the server's DNS.`,
  connection_refused: (noun) => `${noun} refused the connection. Check host, port and that the service is running.`,
  connection_reset: (noun) => `${noun} reset the connection. Often an upstream edge/WAF interrupting the request.`,
  host_unreachable: (noun) => `${noun} host is unreachable from this server (routing or firewall).`,
  network_unreachable: (noun) => `${noun} is unreachable — no outbound network route from this server.`,
  tls_failure: (noun) => `${noun} TLS handshake failed (certificate validation).`,
  network_error: (noun) => `${noun} could not be reached. Check base URL, DNS, TLS and outbound network access.`,
};

export function describeNetworkFailure(category, noun = "Upstream") {
  return (MESSAGES[category] || MESSAGES.network_error)(noun);
}

/** True when the failure is a network/reachability problem, not a credential one. */
export function isNetworkFailure(category) {
  return category !== "invalid_credentials";
}