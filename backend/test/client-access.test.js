/**
 * Tests for the /v1 client-access gate (`settings.requireApiKey`).
 *
 * Regression: enabling "Require API key" — which the Endpoint page actively
 * recommends on public hosts — used to break the built-in Playground. The
 * Playground posts to /api/v1/chat/completions from the dashboard, so it
 * carries the dashboard session cookie and no API key, and every send failed
 * with 401 "Missing API key".
 *
 * A verified `9r_session` cookie is strictly stronger than an API key, so it
 * must satisfy the gate; anonymous traffic must still be rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";

// The session signer resolves its secret at import time.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-client-access";

const {
  DASHBOARD_SESSION_COOKIE,
  parseCookieValue,
  getDashboardSessionToken,
  hasDashboardSession,
  evaluateClientAccess,
  authorizeClientRequest,
} = await import("../src/sse/services/clientAccess.js");
const { createDashboardAuthToken } = await import("../src/lib/auth/dashboardSession.js");

const chatRequest = (cookie) =>
  new Request("http://localhost/api/v1/chat/completions", {
    method: "POST",
    headers: cookie ? { cookie } : {},
  });

const sessionCookie = async () =>
  `${DASHBOARD_SESSION_COOKIE}=${await createDashboardAuthToken()}`;

// ── cookie parsing ────────────────────────────────────────────────────────────

test("parseCookieValue picks the named cookie out of a cookie header", () => {
  const header = "theme=dark; 9r_session=abc.def.ghi; other=1";
  assert.equal(parseCookieValue(header, "9r_session"), "abc.def.ghi");
  assert.equal(parseCookieValue(header, "theme"), "dark");
  assert.equal(parseCookieValue(header, "missing"), "");
  assert.equal(parseCookieValue("", "9r_session"), "");
  assert.equal(parseCookieValue(header, ""), "");
});

test("parseCookieValue keeps '=' characters inside the value", () => {
  assert.equal(parseCookieValue("a=1; tok=x=y=z", "tok"), "x=y=z");
});

test("parseCookieValue ignores malformed segments", () => {
  assert.equal(parseCookieValue("novalue; =empty; tok=ok", "tok"), "ok");
  assert.equal(parseCookieValue("novalue", "tok"), "");
});

test("getDashboardSessionToken reads the cookie header off a Request", () => {
  assert.equal(getDashboardSessionToken(chatRequest("9r_session=tok")), "tok");
  assert.equal(getDashboardSessionToken(chatRequest("")), "");
});

// ── pure gate decision ────────────────────────────────────────────────────────

test("gate is disabled when requireApiKey is off", () => {
  const verdict = evaluateClientAccess({ requireApiKey: false, apiKey: null });
  assert.deepEqual(verdict, { allowed: true, via: "disabled" });
});

test("anonymous request without a key keeps the original error", () => {
  const verdict = evaluateClientAccess({ requireApiKey: true, apiKey: null });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.status, 401);
  assert.equal(verdict.message, "Missing API key");
});

test("a valid API key still authorizes", () => {
  const verdict = evaluateClientAccess({ requireApiKey: true, apiKey: "sk-x", apiKeyValid: true });
  assert.deepEqual(verdict, { allowed: true, via: "api-key" });
});

test("an invalid API key is still rejected when there is no session", () => {
  const verdict = evaluateClientAccess({ requireApiKey: true, apiKey: "sk-bad", apiKeyValid: false });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.status, 401);
  assert.equal(verdict.message, "Invalid API key");
});

test("a dashboard session authorizes without any API key", () => {
  const verdict = evaluateClientAccess({
    requireApiKey: true,
    apiKey: null,
    dashboardSession: true,
  });
  assert.deepEqual(verdict, { allowed: true, via: "dashboard-session" });
});

test("a dashboard session is not defeated by a stale key", () => {
  const verdict = evaluateClientAccess({
    requireApiKey: true,
    apiKey: "sk-bad",
    apiKeyValid: false,
    dashboardSession: true,
  });
  assert.deepEqual(verdict, { allowed: true, via: "dashboard-session" });
});

// ── session verification ──────────────────────────────────────────────────────

test("hasDashboardSession accepts a real session cookie", async () => {
  assert.equal(await hasDashboardSession(chatRequest(await sessionCookie())), true);
});

test("hasDashboardSession rejects missing, empty and forged cookies", async () => {
  assert.equal(await hasDashboardSession(chatRequest("")), false);
  assert.equal(await hasDashboardSession(chatRequest(`${DASHBOARD_SESSION_COOKIE}=`)), false);
  assert.equal(await hasDashboardSession(chatRequest(`${DASHBOARD_SESSION_COOKIE}=not-a-jwt`)), false);
  assert.equal(await hasDashboardSession(undefined), false);
});

test("hasDashboardSession ignores unrelated cookies", async () => {
  assert.equal(await hasDashboardSession(chatRequest("theme=dark; other=1")), false);
});

// ── handler-facing entry point (the Playground path) ──────────────────────────

test("authorizeClientRequest: Playground request (session cookie, no key) is allowed", async () => {
  const verdict = await authorizeClientRequest(chatRequest(await sessionCookie()), null, {
    requireApiKey: true,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.via, "dashboard-session");
});

test("authorizeClientRequest: anonymous request is still rejected", async () => {
  const verdict = await authorizeClientRequest(chatRequest(""), null, { requireApiKey: true });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.status, 401);
  assert.equal(verdict.message, "Missing API key");
});

test("authorizeClientRequest: no session and no key, gate disabled", async () => {
  const verdict = await authorizeClientRequest(chatRequest(""), null, { requireApiKey: false });
  assert.deepEqual(verdict, { allowed: true, via: "disabled" });
});
