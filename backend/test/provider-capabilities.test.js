// Provider model-discovery capabilities.
//
// The dashboard used to assume every provider could be synced and only found
// out at request time. These tests pin the contract: a provider is either
// discovery-capable, import-capable, both, or neither with a usable reason.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_DISCOVERY_PROVIDERS,
  NO_AUTH_DISCOVERY_PROVIDERS,
  getModelCapabilities,
} from "../src/shared/constants/providerCapabilities.js";

test("every listed discovery provider is unique and normalized", () => {
  const unique = new Set(MODEL_DISCOVERY_PROVIDERS);
  assert.equal(unique.size, MODEL_DISCOVERY_PROVIDERS.length);
  for (const id of MODEL_DISCOVERY_PROVIDERS) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
    assert.equal(id, id.trim());
  }
});

test("a provider is not both a per-connection and a no-auth discovery source", () => {
  const overlap = NO_AUTH_DISCOVERY_PROVIDERS.filter((p) =>
    MODEL_DISCOVERY_PROVIDERS.includes(p)
  );
  assert.deepEqual(overlap, []);
});

test("providers with an upstream catalog support discovery and import", () => {
  for (const id of MODEL_DISCOVERY_PROVIDERS) {
    const caps = getModelCapabilities(id);
    assert.equal(caps.supportsDiscovery, true, `${id} should support discovery`);
    assert.equal(caps.supportsImport, true, `${id} should support import`);
    assert.equal(caps.reason, null);
  }
});

test("credential-free providers are syncable but not per-connection importable", () => {
  for (const id of NO_AUTH_DISCOVERY_PROVIDERS) {
    const caps = getModelCapabilities(id);
    assert.equal(caps.supportsDiscovery, true);
    assert.equal(caps.supportsImport, false);
    assert.equal(caps.reason, null);
  }
});

test("compatible nodes are always discovery- and import-capable", () => {
  // A custom node's upstream is user-configured, so it is always probed.
  for (const flag of ["isOpenAICompatible", "isAnthropicCompatible"]) {
    const caps = getModelCapabilities("openai-compatible-chat-abc123", {
      [flag]: true,
    });
    assert.equal(caps.supportsDiscovery, true);
    assert.equal(caps.supportsImport, true);
    assert.equal(caps.reason, null);
  }
});

test("an unknown provider is not discovery-capable and explains why", () => {
  const caps = getModelCapabilities("sdwebui");
  assert.equal(caps.supportsDiscovery, false);
  assert.equal(caps.supportsImport, false);
  // The UI renders `reason` verbatim, so it must name the provider and say
  // what to do instead — a bare "unsupported" gives the user nothing.
  assert.match(caps.reason, /sdwebui/);
  assert.match(caps.reason, /manually/i);
});

test("an empty or missing options object never throws", () => {
  assert.equal(getModelCapabilities("openai", {}).supportsDiscovery, true);
  assert.equal(getModelCapabilities("openai").supportsDiscovery, true);
  assert.equal(getModelCapabilities("nope").supportsDiscovery, false);
});
