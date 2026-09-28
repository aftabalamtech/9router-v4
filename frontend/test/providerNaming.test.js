// Custom-provider naming tests (client side).
//
// The reported bug: a custom provider configured as "Xkiro" displayed
// "OpenAI Compatible" (or its raw `openai-compatible-chat-<uuid>` id) in the
// provider list, the detail page, model cards, selectors, the Playground and
// test-result views. getProviderDisplayName is the single fix; these tests pin
// its precedence rules.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isCustomProviderId,
  buildNodeNameMap,
  getProviderDisplayName,
  getCustomProviderVisuals,
  getModelDisplayName,
} from "../src/shared/utils/providerNaming.js";

import { parseBulkKeys, redactSecrets } from "../src/shared/utils/bulkKeys.js";

const OPENAI_NODE = {
  id: "openai-compatible-chat-11111111-2222-3333-4444-555555555555",
  type: "openai-compatible",
  name: "Xkiro",
  prefix: "xk",
  apiType: "chat",
  baseUrl: "https://api.xkiro.example/v1",
};
const ANTHROPIC_NODE = {
  id: "anthropic-compatible-99999999-8888-7777-6666-555555555555",
  type: "anthropic-compatible",
  name: "Kiro Proxy",
  prefix: "kp",
  baseUrl: "https://proxy.example/v1",
};

describe("custom provider identity", () => {
  it("recognizes all three custom-provider node kinds", () => {
    assert.equal(isCustomProviderId(OPENAI_NODE.id), true);
    assert.equal(isCustomProviderId(ANTHROPIC_NODE.id), true);
    assert.equal(isCustomProviderId("custom-embedding-1234"), true);
    assert.equal(isCustomProviderId("openai"), false);
  });

  it("builds a providerId → name map and skips unnamed nodes", () => {
    const map = buildNodeNameMap([OPENAI_NODE, ANTHROPIC_NODE, { id: "x", name: "  " }, null]);
    assert.equal(map[OPENAI_NODE.id], "Xkiro");
    assert.equal(map[ANTHROPIC_NODE.id], "Kiro Proxy");
    assert.equal("x" in map, false);
  });
});

describe("getProviderDisplayName", () => {
  it("shows the configured name, never the node id", () => {
    assert.equal(getProviderDisplayName(OPENAI_NODE.id, { node: OPENAI_NODE }), "Xkiro");
  });

  it("prefers the node record over a connection's per-key label", () => {
    const name = getProviderDisplayName(OPENAI_NODE.id, {
      node: OPENAI_NODE,
      connection: { name: "Production Key" },
    });
    assert.equal(name, "Xkiro");
  });

  it("falls back to the connection's nodeName when the node list is unavailable", () => {
    const name = getProviderDisplayName(OPENAI_NODE.id, {
      connection: { name: "Key 1", providerSpecificData: { nodeName: "Xkiro" } },
    });
    assert.equal(name, "Xkiro");
  });

  it("resolves through a node-name map", () => {
    const map = buildNodeNameMap([OPENAI_NODE]);
    assert.equal(getProviderDisplayName(OPENAI_NODE.id, { nodeNames: map }), "Xkiro");
  });

  it("uses a generic type label — not the opaque id — when no name is configured", () => {
    const id = "openai-compatible-chat-00000000-0000-0000-0000-000000000000";
    assert.equal(getProviderDisplayName(id, {}), "OpenAI Compatible");
    assert.equal(
      getProviderDisplayName("anthropic-compatible-0000-0000-0000-0000-000000000000", {}),
      "Anthropic Compatible"
    );
  });

  it("never returns the raw node id when a connection has a usable name", () => {
    const id = "openai-compatible-chat-00000000-0000-0000-0000-000000000000";
    const name = getProviderDisplayName(id, { connection: { name: "Team Key" } });
    assert.equal(name, "Team Key");
  });

  it("leaves built-in providers on the static registry", () => {
    assert.equal(getProviderDisplayName("openai", {}), "OpenAI");
    assert.equal(getProviderDisplayName("anthropic", {}), "Anthropic");
  });

  it("honours an explicit override", () => {
    assert.equal(getProviderDisplayName(OPENAI_NODE.id, { node: OPENAI_NODE, override: "Renamed" }), "Renamed");
  });

  it("accepts the node array directly", () => {
    assert.equal(getProviderDisplayName(OPENAI_NODE.id, { providerNodes: [OPENAI_NODE] }), "Xkiro");
  });
});

describe("custom provider visuals", () => {
  it("keeps per-kind color/icon branding", () => {
    assert.equal(getCustomProviderVisuals(ANTHROPIC_NODE.id, ANTHROPIC_NODE).textIcon, "AC");
    assert.equal(getCustomProviderVisuals(OPENAI_NODE.id, OPENAI_NODE).textIcon, "OC");
    assert.equal(getCustomProviderVisuals("custom-embedding-1", { type: "custom-embedding" }).textIcon, "CE");
  });
});

describe("model display names never come from the provider id", () => {
  it("prefers a real name, then the upstream id", () => {
    assert.equal(getModelDisplayName({ id: "gpt-4o", name: "GPT-4o" }), "GPT-4o");
    assert.equal(getModelDisplayName({ id: "gpt-4o" }), "gpt-4o");
    assert.equal(getModelDisplayName("gpt-4o"), "gpt-4o");
    assert.equal(getModelDisplayName(null, "fallback"), "fallback");
  });
});

describe("bulk key parsing (client review step)", () => {
  it("accepts bare keys and auto-names them", () => {
    const { entries, errors } = parseBulkKeys("sk-key-1\nsk-key-2");
    assert.equal(entries.length, 2);
    assert.equal(errors.length, 0);
    assert.deepEqual(entries.map((e) => e.name), ["Key 1", "Key 2"]);
  });

  it("accepts the named format and preserves the name", () => {
    const { entries } = parseBulkKeys("Main | sk-key-1\nAccount 3 | sk-key-3");
    assert.deepEqual(entries.map((e) => e.name), ["Main", "Account 3"]);
    assert.deepEqual(entries.map((e) => e.apiKey), ["sk-key-1", "sk-key-3"]);
  });

  it("splits on the LAST pipe so a key containing a pipe survives", () => {
    const { entries } = parseBulkKeys("Odd | sk-ab|cd");
    assert.equal(entries[0].apiKey, "sk-ab|cd");
  });

  it("keeps valid entries when a neighbour is invalid", () => {
    const { entries, errors } = parseBulkKeys("sk-good-one\n\nab\nsk-good-two");
    assert.equal(entries.length, 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 3);
  });

  it("collapses duplicates inside the paste without echoing the key", () => {
    const { entries, errors } = parseBulkKeys("sk-same-key-value\nsk-same-key-value");
    assert.equal(entries.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /Duplicate key in this paste/);
    assert.equal(errors[0].error.includes("sk-same"), false);
  });

  it("reports keys already configured for this provider without exposing them", () => {
    const { entries, errors } = parseBulkKeys("sk-existing-key-1\nsk-fresh-key-1", {
      existingKeys: ["sk-existing-key-1"],
    });
    assert.deepEqual(entries.map((e) => e.apiKey), ["sk-fresh-key-1"]);
    assert.match(errors[0].error, /already configured/);
    assert.equal(errors[0].error.includes("sk-existing"), false);
  });

  it("redacts credential-shaped substrings in user-facing text", () => {
    // The scheme prefix is kept so the message stays readable; the secret part
    // is always gone.
    assert.equal(redactSecrets("failed for sk-abcdef123456"), "failed for sk-[redacted]");
    assert.equal(redactSecrets("Authorization: Bearer abcdefghijkl"), "Authorization: Bearer [redacted]");
    assert.equal(redactSecrets("plain message"), "plain message");
  });

  it("redacts long unprefixed tokens (e.g. a token echoed by a gateway error)", () => {
    const token = "abcdefghijklmnopqrstuvwxyz0123456789";
    assert.equal(redactSecrets(`upstream said: ${token}`).includes(token), false);
  });

  it("never returns a value containing the secret it was given for known shapes", () => {
    for (const secret of ["sk-abcdef123456", "Bearer abcdefghijkl"]) {
      const out = redactSecrets(`oops ${secret} oops`);
      assert.equal(out.includes(secret.split(" ").pop()), false, `leaked: ${secret}`);
    }
  });
});
