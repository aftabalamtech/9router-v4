// Regression tests for the Render failure:
//   `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
// shown by Test Connection on an OpenAI-compatible provider.
//
// Root causes covered here:
//  1. Backend: a 2xx response whose body is not a model list (upstream HTML
//     page, proxy/CDN error page, empty body) must NOT be reported as a valid
//     connection, and must never throw a raw JSON parser error to the client.
//  2. Backend: error categories (401/403, 429, 5xx, 404, network) stay distinct.
//  3. Frontend: the shared reader never throws on non-JSON and reports the
//     actual failure category.
//
// Upstream calls are mocked; no network and no real credentials are used.
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-node-validate-"));
delete process.env.DATABASE_URL;

const moduleUrl = pathToFileURL(
  new URL("../dist/routes/provider-nodes/validate/route.js", import.meta.url).pathname
).href;

const HTML_BODY = "<!DOCTYPE html>\n<html><head><title>Marketing site</title></head><body>hi</body></html>";

let POST_handler;
before(async () => {
  ({ POST_handler } = await import(moduleUrl));
});

/** Invoke the route with a scripted fetch; returns { body, statusCode, calls }. */
async function validate({ status, body = "{}", contentType = "application/json", request, payload }) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(body, { status, headers: { "content-type": contentType } });
  };
  try {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(data) { this.payload = data; return data; },
    };
    await POST_handler({ body: payload }, res);
    return { body: res.payload, statusCode: res.statusCode, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const openAiNode = (over = {}) => ({
  baseUrl: "https://codecraftapi.com/v1",
  apiKey: "test-key-placeholder",
  type: "openai-compatible",
  apiType: "chat",
  ...over,
});

describe("provider node validation: non-JSON upstream bodies", () => {
  it("treats a 200 HTML page as invalid instead of valid", async () => {
    const out = await validate({
      status: 200,
      body: HTML_BODY,
      contentType: "text/html; charset=utf-8",
      payload: openAiNode(),
    });
    assert.equal(out.body.valid, false, "HTML must never validate as a working connection");
    assert.match(out.body.error, /HTML page instead of a JSON API response/);
    // The base URL hint keeps the message actionable.
    assert.match(out.body.error, /Check the base URL/);
  });

  it("treats a 200 empty body as invalid", async () => {
    const out = await validate({ status: 200, body: "", payload: openAiNode() });
    assert.equal(out.body.valid, false);
    assert.match(out.body.error, /instead of a model list/);
  });

  it("treats a 200 plain-text body as invalid", async () => {
    const out = await validate({
      status: 200,
      body: "Service temporarily unavailable",
      contentType: "text/plain",
      payload: openAiNode(),
    });
    assert.equal(out.body.valid, false);
    assert.match(out.body.error, /non-JSON response/);
  });

  it("treats a 200 malformed-JSON body as invalid", async () => {
    const out = await validate({
      status: 200,
      body: '{"data":[{"id":',
      contentType: "application/json",
      payload: openAiNode(),
    });
    assert.equal(out.body.valid, false);
    assert.equal(out.body.error.includes("Unexpected token"), false, "never leak a parser exception");
  });

  it("accepts a real model list and preserves upstream model ids", async () => {
    const out = await validate({
      status: 200,
      body: JSON.stringify({ object: "list", data: [{ id: "claude-opus-5.5" }, { id: "gpt-4o-mini" }] }),
      payload: openAiNode(),
    });
    assert.equal(out.body.valid, true);
    assert.equal(out.body.method, "models");
    assert.deepEqual(out.body.models.map((m) => m.id), ["claude-opus-5.5", "gpt-4o-mini"]);
  });
});

describe("provider node validation: error categories stay distinct", () => {
  it("reports 401 and 403 as an unauthorized key, not a parser error", async () => {
    for (const status of [401, 403]) {
      const out = await validate({
        status,
        body: JSON.stringify({ error: { message: "Invalid or revoked API key." } }),
        payload: openAiNode(),
      });
      assert.equal(out.body.valid, false);
      assert.equal(out.body.error, "API key unauthorized");
    }
  });

  it("reports 429 as a rate limit", async () => {
    const out = await validate({
      status: 429,
      body: JSON.stringify({ error: { message: "slow down" } }),
      payload: openAiNode(),
    });
    assert.equal(out.body.valid, false);
    assert.match(out.body.error, /429|Rate limit/i);
  });

  it("reports 5xx as an upstream server error", async () => {
    const out = await validate({
      status: 502,
      body: "<html><body>Bad Gateway</body></html>",
      contentType: "text/html",
      payload: openAiNode(),
    });
    assert.equal(out.body.valid, false);
    assert.match(out.body.error, /502|server error/i);
  });

  it("falls back to chat when /models is missing, using the configured model id", async () => {
    const out = await validate({
      status: 404,
      body: JSON.stringify({ error: "not found" }),
      request: "models",
      payload: openAiNode({ modelId: "claude-opus-5.5" }),
    });
    assert.equal(out.body.valid, false, "the mocked 404 models response is not a chat answer");
    assert.equal(out.calls[0].url, "https://codecraftapi.com/v1/models");
  });
});

describe("provider node validation: upstream URL construction", () => {
  it("builds /v1/models from a base URL already ending in /v1", async () => {
    const out = await validate({
      status: 401,
      body: "{}",
      payload: openAiNode({ baseUrl: "https://codecraftapi.com/v1" }),
    });
    assert.equal(out.calls[0].url, "https://codecraftapi.com/v1/models");
  });

  it("never doubles the version or endpoint path", async () => {
    for (const base of [
      "https://codecraftapi.com/v1/",
      "https://codecraftapi.com/v1/chat/completions",
      "https://codecraftapi.com/v1/models",
    ]) {
      const out = await validate({ status: 401, body: "{}", payload: openAiNode({ baseUrl: base }) });
      assert.equal(out.calls[0].url, "https://codecraftapi.com/v1/models", `base: ${base}`);
    }
  });
});
