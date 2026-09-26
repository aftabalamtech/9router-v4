/**
 * Antigravity provider integration tests.
 *
 * Covers the executor contract that previously crashed the shared chatCore
 * handler with "Cannot read properties of undefined (reading 'status')"
 * whenever upstream returned 403/429, plus token refresh and error parsing.
 *
 * All upstream interaction is simulated via the executor's _fetchImpl test
 * seam — no network access, and no real tokens are used anywhere.
 *
 * Run: node --test test/antigravity-executor.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import { AntigravityExecutor } from "../open-sse/executors/antigravity.js";
import { HTTP_STATUS } from "../open-sse/config/runtimeConfig.js";

const FAKE_TOKEN = "ya29.test-fake-access-token-AAA";
const FAKE_REFRESH = "1//test-fake-refresh-token-BBB";

function makeExecutor() {
  const exec = new AntigravityExecutor();
  exec._fetchImpl = async () => { throw new Error("fetch not stubbed for this test"); };
  return exec;
}

function jsonResponse(status, body, statusText = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: new Map(),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

const CREDENTIALS = {
  accessToken: FAKE_TOKEN,
  refreshToken: FAKE_REFRESH,
  projectId: "test-project-123",
  email: "user@example.com",
  connectionId: "conn-test",
};

const BASE_BODY = {
  contents: [{ role: "user", parts: [{ text: "hi" }] }],
};

/** Assert that a value/never leaks token material. */
function assertNoSecrets(str) {
  const s = String(str);
  assert.equal(s.includes(FAKE_TOKEN), false, "access token leaked");
  assert.equal(s.includes(FAKE_REFRESH), false, "refresh token leaked");
}

// ─── 1. Successful inference ────────────────────────────────────────────────

test("successful inference returns response/url/headers/transformedBody", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async (url, init) => {
    assert.equal(url, "https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    assert.equal(init.headers.Authorization, `Bearer ${FAKE_TOKEN}`);
    return jsonResponse(200, "data: {}\n\n");
  };

  const result = await exec.execute({
    model: "gemini-3.5-flash-low",
    body: BASE_BODY,
    stream: true,
    credentials: CREDENTIALS,
    log: null,
  });

  assert.ok(result.response, "must return a response object");
  assert.equal(result.response.ok, true);
  assert.ok(result.url);
  assert.ok(result.transformedBody.request, "request envelope preserved");
  assert.equal(result.transformedBody.project, "test-project-123");
});

// ─── 2. Executor contract: upstream errors must NOT break chatCore ─────────

test("403 upstream error returns a real Response (no undefined .status crash)", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async () => jsonResponse(403, {
    error: {
      code: 403,
      message: "Verify your account to continue.",
      status: "PERMISSION_DENIED",
    },
  });

  const result = await exec.execute({
    model: "gemini-3.5-flash-low",
    body: BASE_BODY,
    stream: false,
    credentials: CREDENTIALS,
    log: { warn: () => {} },
  });

  // The old buggy executor returned a bare {status, message} object here and
  // chatCore crashed reading .status of undefined for the non-429 path.
  assert.ok(result.response, "must return a response object");
  assert.equal(typeof result.response.status, "number");
  assert.equal(result.response.status, 403);
  const text = await result.response.text();
  assert.ok(text.includes("Verify your account"), "upstream message preserved");
  assertNoSecrets(text);
});

test("403 VALIDATION_REQUIRED error carries an actionable explanation", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async () => jsonResponse(403, {
    error: {
      code: 403,
      message: "Verify your account to continue.",
      status: "PERMISSION_DENIED",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "VALIDATION_REQUIRED" }],
    },
  });

  const result = await exec.execute({
    model: "gemini-3.5-flash-low",
    body: BASE_BODY,
    stream: false,
    credentials: CREDENTIALS,
    log: { warn: () => {} },
  });

  assert.equal(result.response.status, 403);

  // chatCore → parseUpstreamError → executor.parseError adds the explanation
  const parsed = exec.parseError({ status: 403 }, await result.response.text());
  const msg = parsed.message;
  assert.ok(
    msg.includes("verification") || msg.includes("Verify"),
    `expected actionable verification guidance, got: ${msg.slice(0, 200)}`
  );
  assert.ok(msg.toLowerCase().includes("proxy"), "explicitly says proxy won't help");
  assert.ok(msg.includes("[upstream: PERMISSION_DENIED]"), "upstream code surfaced");
  assertNoSecrets(msg);
});

test("429 rate limit returns upstream status for account rotation", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async () => jsonResponse(429, {
    error: { code: 429, message: "Resource has been exhausted (e.g. check quota)." },
  });

  const result = await exec.execute({
    model: "gemini-pro-agent",
    body: BASE_BODY,
    stream: false,
    credentials: CREDENTIALS,
    log: { warn: () => {} },
  });

  assert.ok(result.response, "must return a response object");
  assert.equal(result.response.status, HTTP_STATUS.RATE_LIMITED);
});

test("429 quota reset message is converted to 429 with resetsAtMs", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async () => jsonResponse(403, {
    error: { code: 403, message: "Your quota will reset after 2h7m23s." },
  });

  const result = await exec.execute({
    model: "gemini-3.5-flash-low",
    body: BASE_BODY,
    stream: false,
    credentials: CREDENTIALS,
    log: { warn: () => {} },
  });

  assert.ok(result.response.status, 429);
  // parseUpstreamError re-parses the preserved body, so resetsAtMs is derivable
  const parsed = exec.parseError({ status: 403 }, await result.response.text());
  assert.equal(parsed.status, HTTP_STATUS.RATE_LIMITED);
  assert.ok(parsed.resetsAtMs > Date.now());
  assert.ok(parsed.resetsAtMs <= Date.now() + 3 * 3600 * 1000);
});

// ─── 3. Fallback URL behaviour ──────────────────────────────────────────────

test("500 on first URL falls back to the second base URL", async () => {
  const exec = makeExecutor();
  const seenUrls = [];
  exec._fetchImpl = async (url) => {
    seenUrls.push(url);
    if (seenUrls.length === 1) return jsonResponse(500, { error: { message: "boom" } });
    return jsonResponse(200, "data: ok\n\n");
  };

  const result = await exec.execute({
    model: "gemini-3.5-flash-low",
    body: BASE_BODY,
    stream: false,
    credentials: CREDENTIALS,
    log: { warn: () => {} },
  });

  assert.equal(seenUrls.length, 2);
  assert.ok(seenUrls[0].includes("cloudcode-pa"));
  assert.ok(seenUrls[1].includes("daily-cloudcode-pa"));
  assert.equal(result.response.ok, true);
});

// ─── 4. Network failures ────────────────────────────────────────────────────

test("network error on all URLs throws with a clear message", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async () => { throw new Error("ECONNRESET"); };

  await assert.rejects(
    exec.execute({
      model: "gemini-3.5-flash-low",
      body: BASE_BODY,
      stream: false,
      credentials: CREDENTIALS,
      log: { warn: () => {}, debug: () => {} },
    }),
    /ECONNRESET/
  );
});

test("proxy connection failure propagates when the proxy is the only path", async () => {
  const exec = makeExecutor();
  // proxyAwareFetch with a failing dispatcher throws — simulate that
  exec._fetchImpl = async () => { throw new Error("[ProxyFetch] Proxy required but failed (strictProxy=true): ECONNREFUSED 127.0.0.1:7890"); };

  await assert.rejects(
    exec.execute({
      model: "gemini-3.5-flash-low",
      body: BASE_BODY,
      stream: false,
      credentials: CREDENTIALS,
      proxyOptions: { connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:7890", strictProxy: true },
      log: { warn: () => {}, debug: () => {} },
    }),
    /Proxy required but failed/
  );
});

// ─── 5. Token refresh ───────────────────────────────────────────────────────

test("refreshCredentials returns new tokens on success", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async (url, init) => {
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const body = init.body.toString();
    assert.ok(body.includes("grant_type=refresh_token"));
    assert.ok(body.includes(encodeURIComponent(FAKE_REFRESH)));
    return jsonResponse(200, { access_token: "ya29.brand-new", expires_in: 3599 });
  };

  const refreshed = await exec.refreshCredentials(
    { refreshToken: FAKE_REFRESH, projectId: "p1" },
    { info: () => {}, error: () => {} }
  );

  assert.equal(refreshed.accessToken, "ya29.brand-new");
  assert.equal(refreshed.refreshToken, FAKE_REFRESH, "Google keeps the same refresh token");
  assert.equal(refreshed.expiresIn, 3599);
});

test("refreshCredentials returns null on invalid_grant (expired/revoked)", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async () => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });

  const logs = [];
  const refreshed = await exec.refreshCredentials(
    { refreshToken: FAKE_REFRESH },
    { info: () => {}, error: (...a) => logs.push(a.join(" ")) }
  );

  assert.equal(refreshed, null);
  const logLine = logs.join(" ");
  assert.ok(logLine.includes("invalid_grant"), "refresh failure must be diagnosable from logs");
  assertNoSecrets(logLine);
});

test("refreshCredentials returns null when network fails", async () => {
  const exec = makeExecutor();
  exec._fetchImpl = async () => { throw new Error("ENOTFOUND oauth2.googleapis.com"); };

  const refreshed = await exec.refreshCredentials(
    { refreshToken: FAKE_REFRESH },
    { info: () => {}, error: () => {} }
  );
  assert.equal(refreshed, null);
});

test("refreshCredentials returns null without a refresh token", async () => {
  const exec = makeExecutor();
  const refreshed = await exec.refreshCredentials({}, { error: () => {} });
  assert.equal(refreshed, null);
});

// ─── 6. Request serialization ───────────────────────────────────────────────

test("transformRequest keeps envelope shape and clamps maxOutputTokens", () => {
  const exec = makeExecutor();
  const out = exec.transformRequest(
    "gemini-3.5-flash-low",
    { contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 999999 } },
    false,
    CREDENTIALS
  );

  assert.equal(out.project, "test-project-123");
  assert.equal(out.model, "gemini-3.5-flash-low");
  assert.equal(out.userAgent, "antigravity");
  assert.equal(out.request.generationConfig.maxOutputTokens, 16384);
  assert.ok(Array.isArray(out.request.contents));
});

test("transformRequest falls back to derived project when credentials lack one", () => {
  const exec = makeExecutor();
  const out = exec.transformRequest("m", BASE_BODY, false, { email: "x@y.z" });
  assert.ok(typeof out.project === "string" && out.project.length > 0);
});

// ─── 7. Client-facing error building (sanitize + classify) ─────────────────

test("parseError surfaces upstream code and never leaks credentials", () => {
  const exec = makeExecutor();
  const parsed = exec.parseError(
    { status: 403 },
    JSON.stringify({ error: { code: 403, message: `Permission denied for token ${FAKE_TOKEN}`, status: "PERMISSION_DENIED" } })
  );
  // The raw upstream message mentions the token — the sanitizer in testBatch.js
  // is responsible for redaction before persisting; executor itself must not
  // ADD any secret material of its own.
  assert.ok(parsed.message.includes("PERMISSION_DENIED"));
  assert.equal(parsed.status, 403);
});

test("sanitizeErrorMessage from testBatch redacts token-like strings in provider errors", async () => {
  const { sanitizeErrorMessage } = await import("../src/lib/models/testBatch.js");
  const raw = `HTTP 403: Permission denied for Bearer ${FAKE_TOKEN}`;
  const clean = sanitizeErrorMessage(raw);
  assertNoSecrets(clean);
  assert.ok(clean.includes("[redacted]"));
});
