/**
 * Client authorization for the public /v1 (proxy) surface.
 *
 * `settings.requireApiKey` gates the gateway against anonymous internet
 * traffic. The dashboard's own surfaces (Playground, Media Providers) call the
 * same /v1 routes from the browser, but they authenticate with the dashboard
 * session cookie instead of an API key — they have no key to send. A verified
 * `9r_session` cookie is the very credential that unlocks the whole dashboard,
 * so it is strictly stronger than an API key and must satisfy the gate.
 *
 * Without this, turning on "Require API key" (which the Endpoint page actively
 * recommends on public hosts) makes every first-party Playground request fail
 * with a 401 "Missing API key".
 *
 * This is not an auth bypass: anonymous requests still have to present a valid
 * API key, and requests to providers that genuinely need credentials still
 * resolve (or fail to resolve) their stored connection as before.
 */
import { verifyDashboardAuthToken } from "../../lib/auth/dashboardSession.js";
import { isValidApiKey } from "./auth.js";

export const DASHBOARD_SESSION_COOKIE = "9r_session";

export const MISSING_API_KEY_MESSAGE = "Missing API key";
export const INVALID_API_KEY_MESSAGE = "Invalid API key";

/**
 * Read a single cookie value out of a raw `Cookie:` header.
 * @param {string} header
 * @param {string} name
 * @returns {string} cookie value, or "" when absent
 */
export function parseCookieValue(header, name) {
  if (!header || !name) return "";
  for (const part of String(header).split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return "";
}

/** Extract the raw dashboard session token from a request, or "". */
export function getDashboardSessionToken(request) {
  const header =
    request?.headers?.get?.("cookie") ?? request?.headers?.["cookie"] ?? "";
  return parseCookieValue(String(header || ""), DASHBOARD_SESSION_COOKIE);
}

/** True when the request carries an unexpired dashboard session cookie. */
export async function hasDashboardSession(request) {
  const token = getDashboardSessionToken(request);
  if (!token) return false;
  return await verifyDashboardAuthToken(token);
}

/**
 * Pure decision logic for the requireApiKey gate.
 *
 * @param {object} input
 * @param {boolean} input.requireApiKey   - the settings flag
 * @param {string|null} input.apiKey      - key supplied by the client, if any
 * @param {boolean} [input.apiKeyValid]   - result of validating `apiKey`
 * @param {boolean} [input.dashboardSession] - a verified session cookie was present
 * @returns {{allowed: true, via: "disabled"|"dashboard-session"|"api-key"}
 *          | {allowed: false, status: number, message: string}}
 */
export function evaluateClientAccess({
  requireApiKey,
  apiKey,
  apiKeyValid = false,
  dashboardSession = false,
} = {}) {
  if (!requireApiKey) return { allowed: true, via: "disabled" };
  if (dashboardSession) return { allowed: true, via: "dashboard-session" };
  if (!apiKey) return { allowed: false, status: 401, message: MISSING_API_KEY_MESSAGE };
  if (apiKeyValid) return { allowed: true, via: "api-key" };
  return { allowed: false, status: 401, message: INVALID_API_KEY_MESSAGE };
}

/**
 * Enforce the requireApiKey gate for a client request.
 *
 * @param {Request} request
 * @param {string|null} apiKey - key extracted from the request headers
 * @param {{requireApiKey?: boolean}} settings
 * @returns {Promise<{allowed: true, via: string}
 *          | {allowed: false, status: number, message: string}>}
 */
export async function authorizeClientRequest(request, apiKey, settings) {
  if (!settings?.requireApiKey) return { allowed: true, via: "disabled" };

  // A verified dashboard session is at least as strong as an API key.
  const dashboardSession = await hasDashboardSession(request);
  if (dashboardSession) {
    return evaluateClientAccess({ requireApiKey: true, apiKey, dashboardSession: true });
  }

  const apiKeyValid = apiKey ? await isValidApiKey(apiKey) : false;
  return evaluateClientAccess({ requireApiKey: true, apiKey, apiKeyValid, dashboardSession: false });
}
