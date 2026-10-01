// Regression tests: the three provider-validation paths must agree, and none of
// them may call an HTML page, a 429, a 5xx, or a network error "Invalid API key".
//
// The failure this guards against (reported on Render, working on Railway, for
// the OpenAI-compatible provider `codecraftapi`):
//   1. Test Connection on a SAVED connection  POSTs /api/providers/[id]/test
//   2. The API-key "Check" button             POSTs /api/providers/validate
//   3. "Add OpenAI Compatible"                POSTs /api/provider-nodes/validate
// Paths 1 and 2 hard-coded `error: "Invalid API key"` for ANY 401/403, and all
// three frontend callers used `await res.json()`, so a Cloudflare interstitial
// (403 + text/html) surfaced as "Invalid API key" and a non-JSON reply surfaced
// as `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
//
// No network, no credentials: every upstream response is mocked.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-validate-consistency-"));
delete process.env.DATABASE_URL;

const load = (rel) => pathToFileURL(new URL(`../dist/${rel}`, import.meta.url).pathname).href;

// Cloudflare's interstitial — the exact shape seen from Render (and, for a
// while, from other hosts): 403 + text/html + Cloudflare markers.
const CF_CHALLENGE = [
  "<!DOCTYPE html>",
  '<html class="no-js ie6 oldie" lang="en-US">',
  "<head><title>Attention Required! | Cloudflare</title></head>",
  "<body>Checking your browser before accessing. Cloudflare Ray ID: 8f2c1a0b</body>",
  "</html>",
].join("\n");

// CodeCraft API's own marketing page, served at the site root (no /v1).
const MARKET_PAGE = [
  "<!DOCTYPE html>",
  '<html lang="en"><head><title>AI Models &amp; Pricing</title></head>',
  "<body>pricing</body></html>",
].join("\n");

let nodeValidate;      // POST /api/provider-nodes/validate
let providerValidate;  // POST /api/providers/validate
let upstreamDiag;
let networkFailure;

before(async () => {
  ({ POST_handler: nodeValidate } = await import(load("routes/provider-nodes/validate/route.js")));
  upstreamDiag = await import(load("lib/net/upstreamDiagnostics.js"));
  networkFailure = await import(load("lib/net/networkFailure.js"));
  try {
    ({ POST_handler: providerValidate } = await import(load("routes/providers/validate/route.js")));
  } catch {
    providerValidate = null;
  }
});

// The bug: a user-visible message that says the credential is bad. Note the
// phrasing distinction — "this is NOT an API key problem" is helpful and must
// not fail this check, so match the claim rather than the words.
const claimsBadKey = (message) =>
  /API key (rejected|unauthorized|invalid)|Invalid API key|key is invalid/i.test(String(message || ""));

function diag(body, status, contentType, extraHeaders = {}, request = {}) {
  return upstreamDiag.readUpstreamDiagnostic(
    new Response(body, { status, headers: { "content-type": contentType, ...extraHeaders } }),
    { method: "GET", hasAuth: true, ...request }
  );
}

/** Scripted upstream: `responses` are consumed in call order. */
async function withMockedFetch(responses, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  let i = 0;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options?.method || "GET" });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (spec.throwError) throw spec.throwError;
    return new Response(spec.body ?? "", {
      status: spec.status ?? 200,
      headers: spec.headers || { "content-type": "application/json" },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function callNodeValidate(payload, responses) {
  let out;
  const res = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(data) { out = data; return data; },
  };
  const calls = await withMockedFetch(responses, async (c) => {
    await nodeValidate({ body: payload }, res);
    return c;
  });
  return { body: out, statusCode: res.statusCode, calls };
}

const nodePayload = (over = {}) => ({
  baseUrl: "https://codecraftapi.com/v1",
  apiKey: "cc_dummy_key_for_tests",
  type: "openai-compatible",
  apiType: "chat",
  modelId: "claude-opus-4.8",
  ...over,
});

describe("shared upstream classification", () => {
  it("classifies a Cloudflare interstitial as a security challenge", async () => {
    const d = await diag(CF_CHALLENGE, 403, "text/html", { server: "cloudflare", "cf-ray": "abc-TPE" },
      { url: "https://codecraftapi.com/v1/models" });
    assert.equal(d.category, "security_challenge");
    assert.equal(d.status, 403);
    assert.equal(d.headers["cf-ray"], "abc-TPE");
  });

  it("classifies a marketing page as html_response and names the base-URL mistake", async () => {
    const d = await diag(MARKET_PAGE, 200, "text/html", {}, { url: "https://codecraftapi.com/models" });
    assert.equal(d.category, "html_response");
    const message = upstreamDiag.describeUpstreamFailure(d);
    assert.match(message, /HTML page instead of API JSON/);
    assert.match(message, /base URL/i);
    assert.equal(claimsBadKey(message), false, "an HTML page must not be blamed on the key");
  });

  it("never blames the key for a security challenge", async () => {
    const d = await diag(CF_CHALLENGE, 403, "text/html", { server: "cloudflare" });
    assert.equal(upstreamDiag.isCredentialFailure(d), false);
    assert.equal(upstreamDiag.describeUpstreamFailure(d).includes("API key rejected"), false);
    assert.match(upstreamDiag.describeUpstreamFailure(d), /will not attempt to bypass/i);
  });

  it("blames the key only when the body is about the key", async () => {
    const keyish = await diag(JSON.stringify({ error: { message: "Invalid API key." } }), 403, "application/json",
      {}, { apiKey: "cc_dummy_key_for_tests" });
    assert.equal(keyish.category, "access_denied");
    assert.equal(upstreamDiag.isCredentialFailure(keyish), true, "a 403 describing the key is a credential failure");

    const blocked = await diag(JSON.stringify({ error: { message: "Requests from this network are blocked." } }), 403, "application/json");
    assert.equal(upstreamDiag.isCredentialFailure(blocked), false, "an IP block is not a bad key");
    assert.match(upstreamDiag.describeUpstreamFailure(blocked), /does not prove the API key is invalid/);
  });

  it("keeps 429, 5xx, 404 and 405 out of the credential bucket", async () => {
    for (const [status, category] of [
      [429, "rate_limited"], [502, "upstream_server_error"],
      [404, "wrong_endpoint"], [405, "method_not_allowed"],
    ]) {
      const d = await diag(JSON.stringify({ error: { message: "nope" } }), status, "application/json");
      assert.equal(d.category, category, `status ${status}`);
      assert.equal(upstreamDiag.isCredentialFailure(d), false, `status ${status} must not be a credential failure`);
      assert.equal(upstreamDiag.describeUpstreamFailure(d).includes("API key rejected"), false);
    }
  });

  it("redacts an echoed credential and strips markup from preview and detail", async () => {
    const secret = "cc_live_secret_value_7777";
    const d = await diag(`<html><body>bad key ${secret}<script>steal()</script></body></html>`, 401, "text/html",
      {}, { apiKey: secret });
    const publicView = JSON.stringify(upstreamDiag.publicUpstreamDiagnostics(d));
    assert.equal(publicView.includes(secret), false, "no secret may reach the client");
    assert.equal(d.preview.includes("<"), false, "preview must be markup-free");
    assert.equal(d.preview.includes("steal()"), false, "script contents must not survive");
    assert.equal(d.detail.includes("<"), false, "detail must be markup-free");
    assert.equal(upstreamDiag.sanitizeUpstreamText("<b>x</b>  y"), "x y");
  });

  it("never leaks the key through request metadata", async () => {
    const d = await diag(JSON.stringify({ error: "no" }), 401, "application/json", {},
      { url: "https://codecraftapi.com/v1/models", method: "GET", hasAuth: true, apiKey: "cc_dummy_key_for_tests" });
    assert.deepEqual(upstreamDiag.publicUpstreamDiagnostics(d).request, {
      method: "GET", url: "https://codecraftapi.com/v1/models", auth: "bearer",
    });
  });
});

describe("network failures are never credential failures", () => {
  it("maps DNS, TLS, refusal, reset and timeout to distinct categories", () => {
    assert.equal(networkFailure.classifyNetworkFailure({ cause: { code: "ENOTFOUND" } }), "dns_failure");
    assert.equal(networkFailure.classifyNetworkFailure({ cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }), "tls_failure");
    assert.equal(networkFailure.classifyNetworkFailure({ cause: { code: "ECONNREFUSED" } }), "connection_refused");
    assert.equal(networkFailure.classifyNetworkFailure({ cause: { code: "ECONNRESET" } }), "connection_reset");
    assert.equal(networkFailure.classifyNetworkFailure({ name: "TimeoutError" }), "timeout");
  });

  it("unwraps an undici wrapper to the real syscall cause", () => {
    // undici reports a generic "fetch failed" with no code; the truth is nested.
    const undiciTimeout = new Error("fetch failed");
    undiciTimeout.cause = { code: "UND_ERR_CONNECT_TIMEOUT" };
    assert.equal(networkFailure.classifyNetworkFailure(undiciTimeout), "timeout");

    const nestedEtimedout = new Error("fetch failed");
    nestedEtimedout.cause = { cause: { code: "ETIMEDOUT" } };
    assert.equal(networkFailure.classifyNetworkFailure(nestedEtimedout), "timeout");

    const nestedDns = new Error("fetch failed");
    nestedDns.cause = { cause: { code: "ENOTFOUND" } };
    assert.equal(networkFailure.classifyNetworkFailure(nestedDns), "dns_failure");
  });

  it("never claims the credential is bad for a network failure", () => {
    // Assert on the *claim*, not the words: "not an API key problem" is helpful,
    // "API key rejected" is the bug.
    const claimsBadKey = (m) => /API key (rejected|unauthorized|invalid|is invalid)|Invalid API key/i.test(m);
    for (const cat of ["dns_failure", "tls_failure", "timeout", "connection_refused", "connection_reset", "host_unreachable"]) {
      assert.equal(claimsBadKey(networkFailure.describeNetworkFailure(cat)), false, `${cat} must not claim a bad key`);
    }
  });
});

describe("POST /api/provider-nodes/validate (Add OpenAI Compatible)", () => {
  it("never reports a Cloudflare 403 as an invalid key", async () => {
    const { body } = await callNodeValidate(nodePayload(), [
      { status: 403, body: CF_CHALLENGE, headers: { "content-type": "text/html", server: "cloudflare", "cf-ray": "8f-TPE" } },
    ]);
    assert.equal(body.valid, false);
    assert.equal(body.category, "security_challenge");
    assert.equal(claimsBadKey(body.error), false, "a challenge page must not be reported as a bad key");
    assert.match(body.error, /will not attempt to bypass/i);
    assert.equal(body.diagnostics.headers["cf-ray"], "8f-TPE");
  });

  it("never reports a 429 or 5xx as an invalid key", async () => {
    const rate = await callNodeValidate(nodePayload(), [{ status: 429, body: JSON.stringify({ error: { message: "slow down" } }) }]);
    assert.equal(rate.body.category, "rate_limited");
    assert.equal(claimsBadKey(rate.body.error), false);

    const outage = await callNodeValidate(nodePayload(), [
      { status: 502, body: CF_CHALLENGE, headers: { "content-type": "text/html" } },
    ]);
    assert.equal(outage.body.category, "security_challenge");
    assert.equal(claimsBadKey(outage.body.error), false);
  });

  it("still reports a genuine 401 as a credential failure", async () => {
    const { body } = await callNodeValidate(nodePayload(), [
      { status: 401, body: JSON.stringify({ error: { message: "Invalid or revoked API key." } }) },
    ]);
    assert.equal(body.valid, false);
    assert.equal(body.category, "invalid_credentials");
    assert.match(body.error, /API key rejected/);
  });

  it("treats a 405 without JSON as 'no catalog', but an HTML 405 as a failure", async () => {
    // A gateway with no model catalog at all: 405 with an empty body is the
    // clearest signal, and the chat endpoint is the real test.
    const noCatalog = await callNodeValidate(nodePayload(), [
      { status: 405, body: "", headers: { "content-type": "text/plain" } },
      { status: 200, body: JSON.stringify({ choices: [{ message: { content: "pong" } }] }) },
    ]);
    assert.equal(noCatalog.body.valid, true, "a gateway that answers chat after a 405 is reachable");
    assert.equal(noCatalog.calls.length, 2, "the chat endpoint must be tried");

    const html405 = await callNodeValidate(nodePayload(), [
      { status: 405, body: MARKET_PAGE, headers: { "content-type": "text/html" } },
    ]);
    assert.equal(html405.body.valid, false, "an HTML 405 is not 'no catalog here'");
    assert.equal(html405.body.category, "html_response");
  });

  it("reports the marketing site at a /v1-less base URL as a base-URL problem", async () => {
    const { body, calls } = await callNodeValidate(nodePayload({ baseUrl: "https://codecraftapi.com" }), [
      { status: 200, body: MARKET_PAGE, headers: { "content-type": "text/html" } },
    ]);
    assert.equal(calls[0].url, "https://codecraftapi.com/models");
    assert.equal(body.valid, false);
    assert.equal(claimsBadKey(body.error), false);
    assert.match(body.error, /HTML page|base URL/i);
  });

  it("exposes sanitized request metadata but never the key", async () => {
    const secret = "cc_metadata_secret_4242";
    const { body } = await callNodeValidate(nodePayload({ apiKey: secret }), [
      { status: 401, body: JSON.stringify({ error: { message: `Invalid key ${secret}` } }) },
    ]);
    assert.deepEqual(body.diagnostics.request, { method: "GET", url: "https://codecraftapi.com/v1/models", auth: "bearer" });
    assert.equal(JSON.stringify(body).includes(secret), false);
  });

  it("falls back to the chat endpoint and reports its category", async () => {
    const { body, calls } = await callNodeValidate(nodePayload(), [
      { status: 404, body: JSON.stringify({ error: "not found" }) },
      { status: 403, body: CF_CHALLENGE, headers: { "content-type": "text/html", server: "cloudflare" } },
    ]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "https://codecraftapi.com/v1/chat/completions");
    assert.equal(body.category, "security_challenge");
    assert.equal(claimsBadKey(body.error), false);
  });

  it("does not duplicate /v1 or the endpoint path", async () => {
    for (const base of ["https://codecraftapi.com/v1/", "https://codecraftapi.com/v1/chat/completions", "https://codecraftapi.com/v1/models"]) {
      const { calls } = await callNodeValidate(nodePayload({ baseUrl: base }), [
        { status: 401, body: JSON.stringify({ error: "nope" }) },
      ]);
      assert.equal(calls[0].url, "https://codecraftapi.com/v1/models", `base: ${base}`);
    }
  });

  it("accepts a real model list unchanged", async () => {
    const { body } = await callNodeValidate(nodePayload(), [
      { status: 200, body: JSON.stringify({ data: [{ id: "claude-opus-4.8" }] }) },
    ]);
    assert.equal(body.valid, true);
    assert.deepEqual(body.models.map((m) => m.id), ["claude-opus-4.8"]);
  });
});

describe("saved-connection and Check paths agree with node validation", () => {
  it("providers/validate verdicts come from the shared classifier", async () => {
    // The route reads the base URL from the stored provider node, so this test
    // asserts the composition rather than booting the DB-backed path: every
    // failure verdict in the route must be built by verdictFromDiagnostic(),
    // and the bare "Invalid API key" string must be gone from the compatible
    // branches (it is what mislabelled the Render failure).
    const source = fs.readFileSync(
      new URL("../src/routes/providers/validate/route.ts", import.meta.url),
      "utf8"
    );
    const branches = source.slice(source.indexOf("isOpenAICompatibleProvider(provider)"), source.indexOf('provider === "cloudflare-ai"'));
    assert.notEqual(branches.length, 0, "compatible branches not found");
    assert.equal(
      branches.includes('error: "Invalid API key"'),
      false,
      "the compatible branches must not hard-code an invalid-key verdict"
    );
    assert.ok(
      branches.includes("verdictFromDiagnostic("),
      "the compatible branches must build verdicts from the shared classifier"
    );
    // A 403/HTML reply must reach the classifier before any auth special-case.
    assert.equal(/isAuthFailure\(modelsRes\.status\)/.test(branches), false,
      "auth status must not short-circuit before the body is classified");
  });

  it("testUtils uses the shared classifiers and has no hard-coded key verdict", () => {
    const source = fs.readFileSync(
      new URL("../src/routes/providers/[id]/test/testUtils.js", import.meta.url),
      "utf8"
    );
    assert.match(source, /from "@\/lib\/net\/upstreamDiagnostics"/, "testUtils must use the shared classifier");
    assert.match(source, /from "@\/lib\/net\/networkFailure"/, "testUtils must use shared network classification");
    // The regression: a bare invalid-key verdict for any 401/403 inside the
    // compatible branch is exactly what mislabelled the Render failure.
    const start = source.indexOf("isOpenAICompatibleProvider(connection.provider)");
    assert.notEqual(start, -1, "compatible branch not found");
    assert.equal(
      /error:\s*"Invalid API key"/.test(source.slice(start, start + 3000)),
      false,
      "the compatible-connection branch must not hard-code an invalid-key verdict"
    );
  });

  it("no validation path stores raw upstream HTML in an error string", () => {
    for (const rel of ["routes/providers/validate/route.ts", "routes/provider-nodes/validate/route.ts", "routes/providers/[id]/test/testUtils.js"]) {
      const source = fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
      assert.equal(
        /error:\s*`?\[?\$\{?\s*(err\b|errBody\b|statusMessage\b)/.test(source),
        false,
        `${rel} must not interpolate a raw upstream body into an error string`
      );
    }
  });
});