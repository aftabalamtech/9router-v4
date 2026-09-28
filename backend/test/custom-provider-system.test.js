// Custom-provider system tests.
//
// Covers the root causes fixed in this change set:
//  1. OpenAI-compatible base-URL normalization (no doubled endpoints)
//  2. single-read response bodies ("Body is unusable: Body has already been read")
//  3. multiple connections per custom provider (plan-level naming/dedup safety)
//  4. bulk import validation without leaking keys
//  5. provider display naming (the "Xkiro" fix)
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeCompatibleBaseUrl,
  isValidCompatibleBaseUrl,
  buildCompatibleChatUrl,
  buildCompatibleModelsUrl,
  buildCompatibleEmbeddingsUrl,
  apiTypeOf,
} from "../src/lib/net/compatibleUrl.js";

import {
  readJsonBody,
  readResponseOnce,
  parseErrorPayload,
  readBodyText,
} from "../src/lib/net/httpBody.js";

import { planBulkConnections, summarizeBulkPlan } from "../src/lib/models/bulkConnections.js";

// ── 1. Base URL normalization ──────────────────────────────────────────────────

describe("normalizeCompatibleBaseUrl", () => {
  it("keeps a clean base URL untouched", () => {
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1"), "https://host/v1");
    assert.equal(normalizeCompatibleBaseUrl("http://localhost:8000/v1"), "http://localhost:8000/v1");
  });

  it("strips trailing slashes (repeatedly)", () => {
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1/"), "https://host/v1");
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1///"), "https://host/v1");
  });

  it("strips a pasted full endpoint so paths are never doubled", () => {
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1/chat/completions"), "https://host/v1");
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1/models"), "https://host/v1");
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1/messages"), "https://host/v1");
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1/responses"), "https://host/v1");
    assert.equal(normalizeCompatibleBaseUrl("https://host/v1/embeddings"), "https://host/v1");
  });

  it("never appends /v1 (self-hosted gateways live at the root)", () => {
    assert.equal(normalizeCompatibleBaseUrl("https://host"), "https://host");
    assert.equal(buildCompatibleModelsUrl("https://host"), "https://host/models");
  });

  it("strips embedded credentials from the base URL", () => {
    assert.equal(
      normalizeCompatibleBaseUrl("https://user:pass@host/v1"),
      "https://host/v1"
    );
  });

  it("upgrades a schemeless host to https and rejects garbage", () => {
    assert.equal(normalizeCompatibleBaseUrl("api.example.com/v1"), "https://api.example.com/v1");
    assert.equal(normalizeCompatibleBaseUrl("not a url"), "");
    assert.equal(normalizeCompatibleBaseUrl(""), "");
  });

  it("validates http(s) only", () => {
    assert.equal(isValidCompatibleBaseUrl("https://host/v1"), true);
    assert.equal(isValidCompatibleBaseUrl("http://host/v1"), true);
    assert.equal(isValidCompatibleBaseUrl("ftp://host"), false);
    assert.equal(isValidCompatibleBaseUrl("javascript:alert(1)"), false);
  });
});

describe("endpoint builders agree with the base URL", () => {
  const OPENAI_CHAT = "openai-compatible-chat-11111111-2222-3333-4444-555555555555";
  const OPENAI_RESP = "openai-compatible-responses-11111111-2222-3333-4444-555555555555";
  const ANTHROPIC = "anthropic-compatible-11111111-2222-3333-4444-555555555555";
  const EMBED = "custom-embedding-11111111-2222-3333-4444-555555555555";

  it("reads the API type from the node id", () => {
    assert.equal(apiTypeOf(OPENAI_CHAT), "chat");
    assert.equal(apiTypeOf(OPENAI_RESP), "responses");
    assert.equal(apiTypeOf(ANTHROPIC), null);
  });

  it("builds chat endpoints for both api types", () => {
    assert.equal(buildCompatibleChatUrl("https://host/v1", OPENAI_CHAT), "https://host/v1/chat/completions");
    assert.equal(buildCompatibleChatUrl("https://host/v1", OPENAI_RESP), "https://host/v1/responses");
    assert.equal(buildCompatibleChatUrl("https://host/v1", ANTHROPIC), "https://host/v1/messages");
  });

  it("is idempotent: pasting the full endpoint still produces a single path", () => {
    assert.equal(
      buildCompatibleChatUrl("https://host/v1/chat/completions", OPENAI_CHAT),
      "https://host/v1/chat/completions"
    );
    assert.equal(
      buildCompatibleModelsUrl("https://host/v1/models", OPENAI_CHAT),
      "https://host/v1/models"
    );
    assert.equal(
      buildCompatibleChatUrl("https://host/v1/messages", ANTHROPIC),
      "https://host/v1/messages"
    );
  });

  it("chat and models endpoints share the same base", () => {
    for (const base of ["https://host/v1", "https://host/v1/", "https://host/v1/chat/completions"]) {
      const chat = buildCompatibleChatUrl(base, OPENAI_CHAT);
      const models = buildCompatibleModelsUrl(base, OPENAI_CHAT);
      assert.equal(chat.replace("/chat/completions", ""), models.replace("/models", ""));
    }
  });

  it("builds the embeddings endpoint for a custom-embedding node", () => {
    assert.equal(buildCompatibleEmbeddingsUrl("https://host/v1"), "https://host/v1/embeddings");
    assert.equal(
      buildCompatibleEmbeddingsUrl("https://host/v1/embeddings"),
      "https://host/v1/embeddings"
    );
  });

  it("returns empty for an unusable base URL instead of a broken path", () => {
    assert.equal(buildCompatibleChatUrl("", OPENAI_CHAT), "");
    assert.equal(buildCompatibleModelsUrl("nonsense", OPENAI_CHAT), "");
  });
});

// ── 2. Single-read response bodies ────────────────────────────────────────────

/** Minimal Response stand-in that records how many times the body is read. */
function makeResponse({ status = 200, body = "" } = {}) {
  let consumed = false;
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map([["content-type", "application/json"]]),
    get reads() { return consumed ? 1 : 0; },
    async text() {
      if (consumed) {
        // Mirrors undici: the second read is what produced
        // "Body is unusable: Body has already been read".
        throw new TypeError("Body is unusable: Body has already been read");
      }
      consumed = true;
      return body;
    },
    async json() { return JSON.parse(await this.text()); },
  };
}

describe("response bodies are read exactly once", () => {
  it("parses a JSON body", async () => {
    const res = makeResponse({ body: '{"data":[{"id":"gpt-4o"}]}' });
    const { ok, json, text } = await readJsonBody(res);
    assert.equal(ok, true);
    assert.equal(json.data[0].id, "gpt-4o");
    assert.equal(text.length > 0, true);
  });

  it("returns raw text (not a throw) for a non-JSON body", async () => {
    const res = makeResponse({ status: 502, body: "<html>bad gateway</html>" });
    const { ok, json, text } = await readJsonBody(res);
    assert.equal(ok, false);
    assert.equal(json, null);
    assert.equal(text, "<html>bad gateway</html>");
  });

  it("never re-reads: the second read of a consumed body is never attempted", async () => {
    const res = makeResponse({ body: '{"ok":true}' });
    await readResponseOnce(res);
    // readResponseOnce succeeded; a naive `try { json() } catch { text() }` on
    // this response would have thrown. Assert the body was consumed once.
    assert.equal(res.reads, 1);
  });

  it("readBodyText swallows an already-consumed body instead of propagating", async () => {
    const res = makeResponse({ body: "{}" });
    await res.text();
    assert.equal(await readBodyText(res), "");
  });

  it("readResponseOnce reports status, parsed-ness and text together", async () => {
    const res = makeResponse({ status: 401, body: "unauthorized" });
    const out = await readResponseOnce(res);
    assert.equal(out.status, 401);
    assert.equal(out.okStatus, false);
    assert.equal(out.parsed, false);
    assert.equal(out.text, "unauthorized");
  });
});

describe("parseErrorPayload gives actionable diagnostics", () => {
  it("prefers error.message, then error, then message, then raw text", () => {
    assert.equal(parseErrorPayload('{"error":{"message":"bad key"}}'), "bad key");
    assert.equal(parseErrorPayload('{"error":"quota exceeded"}'), "quota exceeded");
    assert.equal(parseErrorPayload('{"message":"nope"}'), "nope");
    assert.equal(parseErrorPayload("plain text failure"), "plain text failure");
  });

  it("falls back to the HTTP status when the body is empty", () => {
    assert.equal(parseErrorPayload("", { status: 503 }), "HTTP 503");
  });
});

// ── 3./4. Bulk connection planning ───────────────────────────────────────────

describe("planBulkConnections", () => {
  it("auto-names entries that have no name", () => {
    const { valid } = planBulkConnections([{ apiKey: "sk-aaaa" }], { defaultNamePrefix: "Xkiro" });
    assert.equal(valid.length, 1);
    assert.equal(valid[0].name, "Xkiro 1");
  });

  it("keeps explicit names and assigns sequential priorities", () => {
    const { valid } = planBulkConnections([
      { name: "Main", apiKey: "sk-aaaa" },
      { name: "Backup", apiKey: "sk-bbbb" },
    ]);
    assert.deepEqual(valid.map((v) => v.name), ["Main", "Backup"]);
    assert.deepEqual(valid.map((v) => v.priority), [1, 2]);
  });

  it("rejects invalid entries individually without dropping valid ones", () => {
    const { valid, invalid } = planBulkConnections([
      { name: "Good", apiKey: "sk-aaaa" },
      { name: "Empty", apiKey: "" },
      { name: "Spaces", apiKey: "sk bb cc" },
      { name: "Short", apiKey: "ab" },
      { name: "AlsoGood", apiKey: "sk-bbbb" },
    ]);
    assert.deepEqual(valid.map((v) => v.name), ["Good", "AlsoGood"]);
    assert.equal(invalid.length, 3);
    // Errors must not leak the key.
    for (const err of invalid) {
      assert.equal(err.error.includes("sk"), false);
    }
  });

  it("detects duplicates against existing connections and within the batch", () => {
    const { valid, duplicates } = planBulkConnections(
      [
        { name: "New", apiKey: "sk-new" },
        { name: "Repeat", apiKey: "sk-new" },
        { name: "Existing", apiKey: "sk-old" },
      ],
      { existingConnections: [{ name: "Old", apiKey: "sk-old" }] }
    );
    assert.deepEqual(valid.map((v) => v.name), ["New"]);
    assert.equal(duplicates.length, 2);
    assert.ok(duplicates.every((d) => !d.error.includes("sk-")));
  });

  it("disambiguates duplicate names so a key never overwrites another connection", () => {
    const { valid } = planBulkConnections(
      [{ name: "Main", apiKey: "sk-aaaa" }],
      { existingConnections: [{ name: "Main", apiKey: "sk-other" }] }
    );
    assert.equal(valid[0].name, "Main 2");
  });

  it("reserves connection names created earlier in the same batch", () => {
    const { valid } = planBulkConnections([
      { name: "Key", apiKey: "sk-aaaa" },
      { name: "Key", apiKey: "sk-bbbb" },
    ]);
    assert.deepEqual(valid.map((v) => v.name), ["Key", "Key 2"]);
  });

  it("rejects an oversized batch", () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({ apiKey: `sk-key-${i}` }));
    const { valid, invalid } = planBulkConnections(entries);
    assert.equal(valid.length, 0);
    assert.equal(invalid.length, 1);
    assert.match(invalid[0].error, /Too many connections/);
  });

  it("summarizeBulkPlan reports counts and reasons without keys", () => {
    const plan = planBulkConnections([
      { name: "A", apiKey: "sk-aaaa" },
      { apiKey: "" },
      { apiKey: "sk-aaaa" },
    ]);
    const summary = summarizeBulkPlan(plan);
    assert.equal(summary.total, 3);
    assert.equal(summary.valid, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.duplicates, 1);
    assert.equal(JSON.stringify(summary).includes("sk-aaaa"), false);
  });

  it("works the same for built-in and custom providers (no provider hardcoding)", () => {
    const { valid } = planBulkConnections([{ apiKey: "sk-aaaa" }], { defaultNamePrefix: "OpenAI" });
    assert.equal(valid[0].name, "OpenAI 1");
  });
});
