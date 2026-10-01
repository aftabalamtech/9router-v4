// Deterministic tests for the provider connectivity layer.
//
// Everything here is mocked: no network, no credentials, no real provider.
// Live upstream checks are a separate concern (see docs/PROVIDER_DIAGNOSTICS.md)
// and are never asserted here.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-provider-conn-"));
delete process.env.DATABASE_URL;

const load = (rel) => pathToFileURL(new URL(`../dist/${rel}`, import.meta.url).pathname).href;

// Resolve every module at module scope. Assigning these inside `before()` leaves
// them undefined while the describe callbacks are registered, which cancels the
// whole suite.
const conn = await import(load("lib/net/providerConnection.js"));
const egress = await import(load("lib/net/egressPolicy.js"));
const { POST_handler: diagnosticsRoute } = await import(load("routes/provider-diagnostics/route.js"));

// ── helpers ──────────────────────────────────────────────────────────────────

const CF_CHALLENGE = [
  "<!DOCTYPE html>",
  '<html class="no-js ie6 oldie" lang="en-US"><head><title>Just a moment...</title></head>',
  "<body>Checking your browser before accessing codecraftapi.com. Enable JavaScript and cookies to continue.</body></html>",
].join("\n");

const MARKET_PAGE = "<!DOCTYPE html>\n<html><head><title>AI Models &amp; Pricing</title></head><body>pricing</body></html>";

const C = conn.FAILURE_CATEGORY;

function res(body, { status = 200, headers = {}, url = "https://api.example.com/v1/models" } = {}) {
  const response = new Response(body, {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

async function classify(body, options = {}, init = {}) {
  return conn.classifyUpstreamResponse(res(body, options), { method: "GET", hasAuth: true, ...init });
}

/** Invoke POST /api/provider-diagnostics against a scripted fetch. */
async function runDiagnostics(requestBody, scripts) {
  const realFetch = globalThis.fetch;
  const seen = [];
  let i = 0;
  globalThis.fetch = async (url, options = {}) => {
    seen.push({ url: String(url), method: options?.method || "GET", headers: options?.headers || {} });
    const spec = scripts[Math.min(i, scripts.length - 1)];
    i += 1;
    if (spec.throwError) throw spec.throwError;
    return res(spec.body ?? "", {
      status: spec.status ?? 200,
      headers: spec.headers || {},
      url: spec.finalUrl || String(url),
    });
  };
  let out;
  const expressRes = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { out = data; return data; },
  };
  try {
    await diagnosticsRoute({ body: requestBody, headers: {} }, expressRes);
    return { body: out, statusCode: expressRes.statusCode, calls: seen };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const target = (over = {}) => ({
  providerId: "openai-compatible-chat-abc",
  baseUrl: "https://api.example.com/v1",
  apiKey: "test-key-placeholder",
  ...over,
});

// ── Phase 1: endpoint construction ───────────────────────────────────────────

describe("endpoint construction", () => {
  it("normalizes every form of a pasted base URL to one endpoint map", () => {
    const expected = {
      models: "https://api.example.com/v1/models",
      chat: "https://api.example.com/v1/chat/completions",
    };
    for (const raw of [
      "https://api.example.com/v1",
      "https://api.example.com/v1/",
      "https://api.example.com/v1/chat/completions",
      "https://api.example.com/v1/models",
      "  https://api.example.com/v1//  ",
      "https://api.example.com/v1/chat/completions/chat/completions",
    ]) {
      const t = conn.describeProviderTarget({ providerId: "openai-compatible-chat-abc", baseUrl: raw });
      assert.deepEqual(t.urls, expected, `base: ${raw}`);
    }
  });

  it("does not append /v1 — self-hosted gateways live at the root", () => {
    const t = conn.describeProviderTarget({ providerId: "openai-compatible-chat-abc", baseUrl: "http://localhost:11434" });
    assert.equal(t.urls.models, "http://localhost:11434/models");
  });

  it("selects /responses from the node id", () => {
    const t = conn.describeProviderTarget({ providerId: "openai-compatible-responses-abc", baseUrl: "https://api.example.com/v1" });
    assert.equal(t.urls.chat, "https://api.example.com/v1/responses");
    assert.equal(t.apiType, "responses");
  });

  it("routes anthropic-compatible providers to /messages with x-api-key", () => {
    const t = conn.describeProviderTarget({ providerId: "anthropic-compatible-chat-abc", baseUrl: "https://api.example.com", apiKey: "k" });
    assert.equal(t.urls.chat, "https://api.example.com/messages");
    assert.equal(t.authScheme, "x-api-key");
    assert.equal(t.headers["x-api-key"], "k");
    assert.equal(t.headers["anthropic-version"], "2023-06-01");
  });

  it("routes custom-embedding providers to /embeddings", () => {
    const t = conn.describeProviderTarget({ providerId: "custom-embedding-abc", baseUrl: "https://api.example.com/v1" });
    assert.equal(t.urls.embeddings, "https://api.example.com/v1/embeddings");
  });

  it("strips credentials embedded in the base URL", () => {
    const t = conn.describeProviderTarget({ providerId: "openai-compatible-chat-abc", baseUrl: "https://user:secret@api.example.com/v1" });
    assert.equal(t.baseUrl, "https://api.example.com/v1");
    assert.equal(JSON.stringify(t).includes("secret"), false);
  });

  it("omits the auth header entirely when no key is configured", () => {
    const t = conn.authHeadersFor({ family: "openai", apiKey: "" });
    assert.equal("Authorization" in t, false, "an empty Bearer header is rejected by some gateways");
  });

  it("returns an actionable error instead of throwing on a bad base URL", () => {
    const t = conn.describeProviderTarget({ providerId: "openai-compatible-chat-abc", baseUrl: "not a url" });
    assert.match(t.error, /Base URL is missing or invalid/);
  });
});

// ── Phase 2: failure taxonomy ────────────────────────────────────────────────

describe("failure classification", () => {
  it("maps every category in the taxonomy", async () => {
    const cases = [
      { name: "invalid_credentials", body: '{"error":{"message":"Invalid API key."}}', status: 401 },
      { name: "permission_denied", body: '{"error":{"message":"Forbidden: this network is blocked."}}', status: 403 },
      { name: "security_challenge", body: CF_CHALLENGE, status: 403, headers: { "content-type": "text/html", server: "cloudflare" } },
      { name: "rate_limited", body: '{"error":"slow down"}', status: 429 },
      { name: "upstream_server_error", body: '{"error":"boom"}', status: 503 },
      { name: "invalid_endpoint", body: MARKET_PAGE, status: 200, headers: { "content-type": "text/html" } },
      { name: "invalid_response", body: "not json at all", status: 418, headers: { "content-type": "text/plain" } },
    ];
    for (const c of cases) {
      const d = await classify(c.body, { status: c.status, headers: c.headers });
      assert.equal(d.category, c.name, `${c.name}: status=${c.status}`);
    }
  });

  it("never turns an HTML response into invalid_credentials", async () => {
    for (const status of [200, 401, 403, 429, 502, 503]) {
      const d = await classify(MARKET_PAGE, { status, headers: { "content-type": "text/html" } });
      assert.notEqual(d.category, C.INVALID_CREDENTIALS, `HTML at status ${status} must not be a credential failure`);
      assert.equal(d.isCredentialFailure, false);
    }
  });

  it("separates a credential 403 from an IP-block 403", async () => {
    const aboutKey = await classify('{"error":{"message":"Invalid API key for this project."}}', { status: 403 });
    assert.equal(aboutKey.category, C.INVALID_CREDENTIALS);
    assert.equal(aboutKey.isCredentialFailure, true);

    const aboutNetwork = await classify('{"error":{"message":"Forbidden: requests from this network are blocked."}}', { status: 403 });
    assert.equal(aboutNetwork.category, C.PERMISSION_DENIED);
    assert.equal(aboutNetwork.isCredentialFailure, false);
  });

  it("calls an edge 429 rate_limited, not a security challenge", async () => {
    // Observed live: Cloudflare error 1015 arrives as plain-text 429. Calling
    // it a challenge would point the operator at a nonexistent IP block.
    const d = await classify("error code: 1015", { status: 429, headers: { "content-type": "text/plain", server: "cloudflare" } });
    assert.equal(d.category, C.RATE_LIMITED);
    assert.match(conn.remediationFor(d.category), /rate limiting/i);
  });

  it("does not call a generic Cloudflare 5xx a challenge", async () => {
    const d = await classify("upstream connect error", { status: 521, headers: { "content-type": "text/html", server: "cloudflare" } });
    assert.equal(d.category, C.INVALID_ENDPOINT, "a 521 origin failure is not an interactive challenge");
    assert.notEqual(d.category, C.SECURITY_CHALLENGE);
  });

  it("detects an edge challenge from headers alone when the body is opaque", async () => {
    const d = await classify("Access denied", {
      status: 403,
      headers: { "content-type": "text/html", server: "cloudflare", "cf-mitigated": "challenge" },
    });
    assert.equal(d.category, C.SECURITY_CHALLENGE);
  });

  it("reports a redirect instead of following it", async () => {
    const d = await classify("", { status: 302, headers: { location: "https://elsewhere.example/login" } });
    assert.equal(d.redirected, true);
    assert.equal(d.category, C.INVALID_ENDPOINT);
    assert.equal(d.location, "https://elsewhere.example/login");
  });

  it("classifies transport failures by walking the cause chain", () => {
    const timeout = new Error("fetch failed");
    timeout.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
    assert.equal(conn.classifyNetworkFailure(timeout), C.TIMEOUT);

    const dns = new Error("fetch failed");
    dns.cause = { cause: { code: "ENOTFOUND" } };
    assert.equal(conn.classifyNetworkFailure(dns), C.DNS_ERROR);

    const tls = new Error("fetch failed");
    tls.cause = { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };
    assert.equal(conn.classifyNetworkFailure(tls), C.TLS_ERROR);

    assert.equal(conn.classifyNetworkFailure({ name: "TimeoutError" }), C.TIMEOUT);
    assert.equal(conn.classifyNetworkFailure(null), C.NETWORK_ERROR);
  });

  it("preserves status and a sanitized preview for every failure", async () => {
    const d = await classify(CF_CHALLENGE, { status: 403, headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "abc-TPE" } });
    assert.equal(d.status, 403);
    assert.ok(d.preview.length > 0);
    assert.equal(d.preview.includes("<"), false, "preview must be markup-free");
    assert.equal(d.diagnostics["cf-ray"], "abc-TPE");
    assert.equal(d.diagnostics.server, "cloudflare");
  });
});

// ── Secret handling ──────────────────────────────────────────────────────────

describe("credential redaction", () => {
  it("never leaks a key through the client-facing diagnostic", async () => {
    const secret = "cc_live_secret_abcdef123456";
    const cases = [
      `{"error":{"message":"Invalid key ${secret}"}}`,
      `{"error":{"message":"Bearer ${secret}"}}`,
      `<html><body>token=${secret}</body></html>`,
      `{"error":"api_key=${secret}"}`,
    ];
    for (const body of cases) {
      const d = await classify(body, {
        status: 401,
        headers: { "content-type": body.startsWith("<") ? "text/html" : "application/json" },
      }, { apiKey: secret });
      // publicDiagnostic() is the client boundary and must be clean.
      const publicView = JSON.stringify(conn.publicDiagnostic(d));
      assert.equal(publicView.includes(secret), false, `leaked via public diagnostic: ${body.slice(0, 40)}`);
      // The rendered message and remediation are also client-bound.
      assert.equal(conn.describeFailure(d).includes(secret), false);
    }
  });

  it("keeps the raw body out of publicDiagnostic but available internally", async () => {
    const secret = "cc_internal_only_11223344";
    const d = await classify(`{"error":{"message":"Invalid ${secret}"}}`, { status: 401 }, { apiKey: secret });
    // Internally available for payload inspection (e.g. reading a catalog).
    assert.ok(d.json, "raw JSON must be available to internal callers");
    // …but structurally excluded from anything sent to a client.
    const publicKeys = Object.keys(conn.publicDiagnostic(d));
    assert.equal(publicKeys.includes("text"), false, "raw text must not be public");
    assert.equal(publicKeys.includes("json"), false, "raw JSON must not be public");
  });

  it("records only the presence of a credential in request metadata", async () => {
    const d = await classify('{"error":"x"}', { status: 401 }, { apiKey: "cc_secret_12345678" });
    assert.equal(d.request.auth, "present");
    assert.equal(JSON.stringify(d.request).includes("cc_secret"), false);
  });

  it("redacts provider-shaped key prefixes", () => {
    assert.equal(conn.redactSecrets("key sk-proj-ABCDEF123456"), "key sk_[redacted]");
    assert.equal(conn.redactSecrets("cc_AbCdEf1234567890"), "cc_[redacted]");
  });

  it("strips scripts and comments from previews", () => {
    const evil = "<div><!-- hidden --><script>steal()</script>Safe text</div>";
    assert.equal(conn.sanitizeUpstreamText(evil), "Safe text");
  });

  it("keeps remediation separate from the failure message", () => {
    const d = { category: C.SECURITY_CHALLENGE, status: 403, detail: "challenge", preview: "" };
    const message = conn.describeFailure(d, { noun: "api.example.com" });
    assert.match(message, /will not attempt to bypass/i);
    assert.match(conn.remediationFor(C.SECURITY_CHALLENGE), /allowlist/i);
  });
});

// ── Phase 3: diagnostics endpoint ────────────────────────────────────────────

describe("POST /api/provider-diagnostics", () => {
  it("runs four independent checks and keeps the three successes distinct", async () => {
    const { body } = await runDiagnostics(target({ modelId: "m-1", includeChat: true }), [
      { status: 401, body: '{"error":{"message":"Missing API key."}}' },        // network (unauth)
      { status: 200, body: '{"data":[{"id":"m-1"}]}' },                          // credential
      { status: 200, body: '{"data":[{"id":"m-1"},{"id":"m-2"}]}' },             // models
      { status: 200, body: '{"choices":[{"message":{"content":"pong"}}]}' },      // chat
    ]);
    assert.deepEqual(Object.keys(body.results), ["credential", "models", "chat", "network"]);
    assert.deepEqual(body.results, { credential: true, models: true, chat: true, network: true });
    assert.equal(body.verdict, "healthy");
    assert.equal(body.checks.length, 4);
  });

  it("reports an unreachable host as blocked, not as a bad key", async () => {
    const { body } = await runDiagnostics(target(), [
      { throwError: Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }) },
    ]);
    assert.equal(body.results.network, false);
    assert.equal(body.verdict, "unreachable");
    assert.equal(body.category, C.DNS_ERROR);
    assert.equal(body.checks.find((c) => c.name === "credential").credentialRejected, false);
  });

  it("distinguishes a challenge page from an invalid credential", async () => {
    const { body } = await runDiagnostics(target(), [
      { status: 403, body: CF_CHALLENGE, headers: { "content-type": "text/html", server: "cloudflare" } },
      { status: 403, body: CF_CHALLENGE, headers: { "content-type": "text/html", server: "cloudflare" } },
    ]);
    assert.equal(body.category, C.SECURITY_CHALLENGE);
    assert.equal(body.verdict, "blocked");
    assert.equal(body.results.network, true, "an HTTP answer proves the network path works");
    assert.equal(body.results.credential, false);
    assert.equal(body.checks.find((c) => c.name === "credential").credentialRejected, false);
    assert.match(body.remediation, /allowlist|bypass/i);
  });

  it("reports a genuine rejected credential as invalid_credentials", async () => {
    const { body } = await runDiagnostics(target(), [
      { status: 401, body: '{"error":{"message":"Missing API key."}}' },
      { status: 401, body: '{"error":{"message":"Invalid or revoked API key."}}' },
    ]);
    assert.equal(body.verdict, "invalid_credentials");
    assert.equal(body.category, C.INVALID_CREDENTIALS);
    assert.equal(body.results.credential, false);
    assert.equal(body.checks.find((c) => c.name === "network").ok, true);
  });

  it("treats a missing catalog as unsupported, not a failure of the provider", async () => {
    const { body } = await runDiagnostics(target(), [
      { status: 401, body: '{"error":"no key"}' },
      { status: 200, body: '{"object":"list","data":[{"id":"only-model"}]}' },
      { status: 405, body: '{"error":"method not allowed"}' },
    ]);
    const models = body.checks.find((c) => c.name === "models");
    assert.equal(models.category, C.UNSUPPORTED_OPERATION);
    assert.equal(body.results.credential, true);
  });

  it("skips the chat probe unless it is requested with a model id", async () => {
    const withoutChat = await runDiagnostics(target(), [{ status: 200, body: '{"data":[]}' }]);
    assert.equal(withoutChat.body.checks.some((c) => c.name === "chat"), false);

    const withChatNoModel = await runDiagnostics(target({ includeChat: true }), [{ status: 200, body: '{"data":[]}' }]);
    assert.equal(withChatNoModel.body.checks.some((c) => c.name === "chat"), false, "a chat probe without a model id would fail for the wrong reason");
  });

  it("never echoes the submitted key in any field", async () => {
    const secret = "cc_diag_secret_99887766";
    const { body } = await runDiagnostics(
      target({ apiKey: secret }),
      [{ status: 401, body: `{"error":{"message":"Invalid key ${secret}"}}` }]
    );
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(body.target.hasApiKey, true);
  });

  it("rejects a non-absolute, non-http, or credential-bearing base URL", async () => {
    for (const [baseUrl, pattern] of [
      ["not-a-url", /not a valid absolute URL|missing or invalid/i],
      ["file:///etc/passwd", /Unsupported protocol|missing or invalid/i],
      ["ftp://example.com", /Unsupported protocol|missing or invalid/i],
      ["https://user:pass@api.example.com/v1", /must not embed credentials/i],
    ]) {
      const { body, statusCode } = await runDiagnostics(target({ baseUrl }), [{ status: 200, body: "{}" }]);
      assert.equal(statusCode, 400, `baseUrl: ${baseUrl}`);
      assert.match(body.error, pattern);
    }
  });

  it("refuses to probe cloud metadata or private hosts (SSRF)", async () => {
    // Diagnostics is authenticated but still must not become a request-forgery
    // primitive for the host it runs on.
    for (const baseUrl of ["http://169.254.169.254/v1", "http://localhost:3001", "http://192.168.1.10/v1"]) {
      const { body, statusCode } = await runDiagnostics(target({ baseUrl }), [{ status: 200, body: "{}" }]);
      assert.equal(statusCode, 400, baseUrl);
      assert.match(body.error, /metadata|private|loopback|ALLOW_PRIVATE_EGRESS/i);
    }
  });

  it("rejects an oversized request body before doing any work", async () => {
    const realFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; return res("{}"); };
    let out;
    const expressRes = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(d) { out = d; return d; } };
    try {
      await diagnosticsRoute(
        { body: target(), headers: { "content-length": String(64 * 1024) } },
        expressRes
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.equal(expressRes.statusCode, 413);
    assert.equal(called, false, "no outbound request may be made for an oversized body");
  });

  it("returns the resolved target without the credential", async () => {
    const { body } = await runDiagnostics(target(), [{ status: 200, body: '{"data":[]}' }]);
    assert.equal(body.target.modelsUrl, "https://api.example.com/v1/models");
    assert.equal(body.target.chatUrl, "https://api.example.com/v1/chat/completions");
    assert.equal("apiKey" in body.target, false);
  });
});

// ── Phase 4: egress policy / SSRF ────────────────────────────────────────────

describe("egress policy (SSRF protection)", () => {
  const saved = process.env.ALLOW_PRIVATE_EGRESS;

  afterEach(() => {
    if (saved === undefined) delete process.env.ALLOW_PRIVATE_EGRESS;
    else process.env.ALLOW_PRIVATE_EGRESS = saved;
  });

  it("allows ordinary public provider URLs", () => {
    assert.equal(egress.validateOutboundUrl("https://api.example.com/v1").ok, true);
    assert.equal(egress.validateOutboundUrl("http://api.example.com/v1").ok, true);
  });

  it("always blocks cloud metadata endpoints", () => {
    process.env.ALLOW_PRIVATE_EGRESS = "true";
    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://100.100.100.200/",
    ]) {
      const r = egress.validateOutboundUrl(url);
      assert.equal(r.ok, false, url);
      assert.match(r.reason, /metadata/i);
    }
  });

  it("blocks private destinations unless explicitly opted into", () => {
    process.env.ALLOW_PRIVATE_EGRESS = "";
    for (const url of ["http://localhost:11434", "http://192.168.1.10:8000/v1", "http://127.0.0.1:3001"]) {
      const r = egress.validateOutboundUrl(url);
      assert.equal(r.ok, false, url);
      assert.match(r.reason, /ALLOW_PRIVATE_EGRESS/);
    }
  });

  it("permits self-hosted gateways when private egress is enabled", () => {
    process.env.ALLOW_PRIVATE_EGRESS = "true";
    assert.equal(egress.validateOutboundUrl("http://localhost:11434").ok, true);
    assert.equal(egress.validateOutboundUrl("http://192.168.1.10:8000/v1").ok, true);
  });

  it("supports a host and CIDR allowlist", () => {
    process.env.ALLOW_PRIVATE_EGRESS = "localhost,192.168.1.0/24";
    assert.equal(egress.validateOutboundUrl("http://localhost:11434").ok, true);
    assert.equal(egress.validateOutboundUrl("http://192.168.1.10:8000").ok, true);
    assert.equal(egress.validateOutboundUrl("http://10.0.0.5:8000").ok, false, "10/8 is not in the allowlist");
  });

  it("rejects non-http schemes and embedded credentials", () => {
    for (const url of ["file:///etc/passwd", "gopher://x", "ftp://x", "https://a:b@x.example"]) {
      assert.equal(egress.validateOutboundUrl(url).ok, false, url);
    }
  });

  it("rejects documentation IP ranges", () => {
    for (const url of ["http://192.0.2.1/v1", "http://198.51.100.7/v1", "http://203.0.113.9/v1"]) {
      assert.equal(egress.validateOutboundUrl(url).ok, false, url);
    }
  });

  it("requires an explicit port and HTTPS for a relay endpoint", () => {
    process.env.ALLOW_PRIVATE_EGRESS = "true";
    assert.equal(egress.validateProxyEndpoint("https://relay.example.com").ok, false, "port is required");
    assert.equal(egress.validateProxyEndpoint("http://relay.example.com:443").ok, false, "HTTPS is required");
    assert.equal(egress.validateProxyEndpoint("https://relay.example.com:8443").ok, true);
  });

  it("keeps a relay from pointing at the metadata service", () => {
    process.env.ALLOW_PRIVATE_EGRESS = "true";
    assert.equal(egress.validateProxyEndpoint("https://169.254.169.254:8443").ok, false);
  });

  it("rejects control characters and absurd lengths", () => {
    assert.equal(egress.validateOutboundUrl("https://a.example/\u0000evil").ok, false);
    assert.equal(egress.validateOutboundUrl(`https://a.example/${"x".repeat(3000)}`).ok, false);
  });

  it("summarizes the active policy for the UI", () => {
    process.env.ALLOW_PRIVATE_EGRESS = "";
    assert.equal(egress.egressPolicySummary().privateEgress, "disabled");
    process.env.ALLOW_PRIVATE_EGRESS = "true";
    assert.equal(egress.egressPolicySummary().privateEgress, "allow_all");
  });
});

// ── outbound request policy ──────────────────────────────────────────────────

describe("providerFetch policy", () => {
  it("uses a deadline and never follows redirects automatically", async () => {
    const calls = [];
    const fake = async (url, options) => { calls.push(options); return res("{}", { status: 200 }); };
    await conn.providerFetch("https://api.example.com/v1/models", { fetchImpl: fake });
    assert.equal(calls[0].redirect, "manual", "a redirect could move the Authorization header off-host");
    assert.ok(calls[0].signal, "a deadline signal is always required");
  });

  it("honours a caller signal alongside its own deadline", async () => {
    const calls = [];
    const fake = async (url, options) => { calls.push(options); return res("{}"); };
    const external = new AbortController();
    await conn.providerFetch("https://api.example.com/v1/models", { fetchImpl: fake, signal: external.signal });
    assert.ok(calls[0].signal);
  });

  it("aborts once the timeout elapses", async () => {
    const fake = async (url, options) => new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
        return;
      }
      options.signal.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      });
    });
    await assert.rejects(
      () => conn.providerFetch("https://api.example.com/v1/models", { fetchImpl: fake, timeoutMs: 40 }),
      (error) => {
        // Classified as a timeout, never as a credential problem.
        assert.equal(error.name, "TimeoutError");
        assert.equal(conn.classifyNetworkFailure(error), C.TIMEOUT);
        return true;
      }
    );
  });
});