/**
 * Shared fetch timeout helper.
 *
 * Dashboard handlers call out to third-party providers. A provider that accepts
 * the TCP connection and then stalls (no RST, no response) would otherwise hold
 * the HTTP request open indefinitely, which blocks the models/providers pages
 * and ties up the request handler. Every outbound provider call should go
 * through here so a slow upstream degrades to an error instead of a hang.
 */

/** Default ceiling for provider/validation calls. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;

/**
 * fetch() with an AbortSignal timeout.
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number }} [options]
 */
export function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS, signal, ...rest } = options;
  // Respect a caller-supplied signal while still enforcing our own deadline.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...rest, signal: combined });
}

export default fetchWithTimeout;
