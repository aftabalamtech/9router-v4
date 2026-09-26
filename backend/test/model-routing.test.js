/**
 * Model-routing regression tests.
 *
 * Context: the Playground showed two failed bubbles labelled
 * "via openrouter/openrouter/free" and "via oc/space-bunny-free". Both are the
 * client-side "Sends as" preview of what the user submitted — not a backend
 * re-route — and both failed in the same place (the requireApiKey gate).
 *
 * These tests pin the routing itself so it can never drift: "oc" is the
 * OpenCode Free alias (noAuth, no key needed) and an explicit model id is
 * preserved verbatim, including OpenRouter's own "openrouter/free" model.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { parseModel, resolveProviderAlias } from "../open-sse/services/model.js";
import { PROVIDER_ID_TO_ALIAS } from "../open-sse/config/providerModels.js";
import { resolveProviderId, getProviderAlias, FREE_PROVIDERS } from "../src/shared/constants/providers.js";

test("oc/space-bunny-free routes to the opencode provider", () => {
  const parsed = parseModel("oc/space-bunny-free");
  assert.equal(parsed.providerAlias, "oc");
  assert.equal(parsed.provider, "opencode");
  assert.equal(parsed.model, "space-bunny-free");
  assert.equal(parsed.isAlias, false);
});

test("a slash inside the upstream model id is preserved", () => {
  assert.deepEqual(parseModel("openrouter/openrouter/free"), {
    providerAlias: "openrouter",
    provider: "openrouter",
    model: "openrouter/free",
    isAlias: false,
  });
  assert.deepEqual(parseModel("oc/vendor/space-bunny-free"), {
    providerAlias: "oc",
    provider: "opencode",
    model: "vendor/space-bunny-free",
    isAlias: false,
  });
});

test("opencode alias maps to the opencode provider id in both directions", () => {
  assert.equal(PROVIDER_ID_TO_ALIAS.opencode, "oc");
  assert.equal(resolveProviderAlias("oc"), "opencode");
  assert.equal(resolveProviderId("oc"), "opencode");
  assert.equal(getProviderAlias("opencode"), "oc");
});

test("opencode is declared noAuth so it never needs a provider API key", () => {
  assert.equal(FREE_PROVIDERS.opencode.noAuth, true);
  assert.equal(FREE_PROVIDERS.opencode.alias, "oc");
});

test("selecting OpenCode Free never resolves to an OpenRouter provider", () => {
  const parsed = parseModel("oc/space-bunny-free");
  assert.notEqual(parsed.provider, "openrouter");
  assert.ok(!parsed.model.includes("openrouter"));
  assert.ok(!String(parsed.providerAlias).includes("openrouter"));
});

test("a bare model id is an alias lookup, not a provider route", () => {
  const parsed = parseModel("space-bunny-free");
  assert.equal(parsed.isAlias, true);
  assert.equal(parsed.provider, null);
  assert.equal(parsed.model, "space-bunny-free");
});

test("manually entered provider-qualified ids keep their provider", () => {
  assert.equal(parseModel("oc/my-custom-model").provider, "opencode");
  assert.equal(parseModel("nvidia/nvidia/ising-model").provider, "nvidia");
  assert.equal(parseModel("nvidia/nvidia/ising-model").model, "nvidia/ising-model");
});
