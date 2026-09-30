// Frontend regression tests for the shared response reader.
//
// Root cause: Test Connection called `res.json()` unconditionally, so any
// non-JSON reply produced `Unexpected token '<', "<!DOCTYPE "... is not valid
// JSON` in the UI. The reader must classify the failure instead.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readJsonResponse, fetchValidationResult } from "../src/shared/utils/safeJson.js";

const HTML_BODY = "<!DOCTYPE html>\n<html><head><title>9Router</title></head><body>Not found</body></html>";

/** Minimal Response stand-in (Node's global Response is available, but a stub
 *  keeps the tests independent of undici body-read semantics). */
function fakeResponse({ status = 200, body = "", contentType = "application/json" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === "content-type" ? contentType : null) },
    async text() { return body; },
  };
}

before(() => {
  globalThis.window = globalThis;
});

describe("readJsonResponse", () => {
  it("parses a valid JSON success response", async () => {
    const out = await readJsonResponse(fakeResponse({ body: '{"valid":true,"models":[]}' }));
    assert.equal(out.ok, true);
    assert.equal(out.data.valid, true);
  });

  it("surfaces a JSON error body message", async () => {
    const out = await readJsonResponse(
      fakeResponse({ status: 500, body: '{"error":"Internal server error while handling the request"}' })
    );
    assert.equal(out.ok, false);
    assert.match(out.error, /Internal server error/);
  });

  it("classifies an HTML page instead of throwing a parser error", async () => {
    const out = await readJsonResponse(
      fakeResponse({ status: 502, body: HTML_BODY, contentType: "text/html" })
    );
    assert.equal(out.ok, false);
    assert.equal(out.data, null);
    assert.match(out.error, /HTML page/);
    assert.equal(/Unexpected token/.test(out.error), false);
  });

  it("classifies plain text and empty bodies", async () => {
    const text = await readJsonResponse(
      fakeResponse({ status: 200, body: "not json at all", contentType: "text/plain" })
    );
    assert.equal(text.ok, false);
    assert.match(text.error, /not json at all/);

    const empty = await readJsonResponse(fakeResponse({ status: 204, body: "" }));
    assert.equal(empty.ok, false);
    assert.match(empty.error, /empty/i);
  });

  it("handles malformed JSON without throwing", async () => {
    const out = await readJsonResponse(
      fakeResponse({ status: 200, body: '{"data":[{"id":', contentType: "application/json" })
    );
    assert.equal(out.ok, false);
    assert.equal(/Unexpected token|Unexpected end/.test(out.error), false);
  });
});

describe("fetchValidationResult", () => {
  it("returns the backend payload for a successful validation", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse({ body: '{"valid":true,"method":"models","models":[]}' });
    try {
      const out = await fetchValidationResult("/api/provider-nodes/validate", { baseUrl: "https://x/v1" });
      assert.equal(out.valid, true);
      assert.equal(out.method, "models");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns an actionable error for an HTML reply (Render/Render-proxy page)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => fakeResponse({ status: 502, body: HTML_BODY, contentType: "text/html" });
    try {
      const out = await fetchValidationResult("/api/provider-nodes/validate", { baseUrl: "https://x/v1" });
      assert.equal(out.valid, false);
      assert.match(out.error, /HTML page|could not complete/i);
      assert.equal(/Unexpected token/.test(out.error), false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("marks a 500 from the app itself as a server fault, not an invalid key", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      fakeResponse({ status: 500, body: '{"error":"Internal server error while handling the request"}' });
    try {
      const out = await fetchValidationResult("/api/provider-nodes/validate", { baseUrl: "https://x/v1" });
      assert.equal(out.valid, false);
      assert.match(out.error, /could not complete/i);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reports an unreachable API instead of a parser error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    try {
      const out = await fetchValidationResult("/api/provider-nodes/validate", { baseUrl: "https://x/v1" });
      assert.equal(out.valid, false);
      assert.match(out.error, /Could not reach the 9Router API/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
