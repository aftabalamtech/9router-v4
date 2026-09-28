// Tests for the model display label helpers.
//
// Pins the fix for the "openai-compatible-chat-<uuid>/..." truncation bug on
// the Models page: the bare upstream model id is the primary label, the full
// provider-prefixed identity stays reachable via tooltip/copy.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  stripProviderPrefix,
  modelPrimaryLabel,
  hasDistinctDisplayName,
} from "../src/shared/utils/modelDisplay.js";

const NODE_ID = "openai-compatible-chat-afecb65c-10bf-4bba-8a11-1a2b3c4d5e6f";

describe("stripProviderPrefix", () => {
  it("strips the exact provider prefix", () => {
    assert.equal(stripProviderPrefix(`${NODE_ID}/qwen/qwen3.5-plus:free`, NODE_ID), "qwen/qwen3.5-plus:free");
  });

  it("leaves a model id that merely contains the provider text", () => {
    assert.equal(stripProviderPrefix("prefix-similar/model", "prefix"), "prefix-similar/model");
  });

  it("returns the input unchanged when alias is empty", () => {
    assert.equal(stripProviderPrefix("openai/gpt-4o", ""), "openai/gpt-4o");
  });
});

describe("modelPrimaryLabel", () => {
  it("shows the actual model id, not the opaque provider prefix", () => {
    assert.equal(
      modelPrimaryLabel({
        id: "qwen/qwen3.5-plus:free",
        fullModel: `${NODE_ID}/qwen/qwen3.5-plus:free`,
        providerAlias: NODE_ID,
      }),
      "qwen/qwen3.5-plus:free"
    );
  });

  it("prefers a distinct display name when provided", () => {
    assert.equal(
      modelPrimaryLabel({
        id: "gpt-4o",
        fullModel: "openai/gpt-4o",
        providerAlias: "openai",
        name: "GPT-4o",
      }),
      "GPT-4o"
    );
  });

  it("ignores a name that just duplicates the id", () => {
    assert.equal(
      modelPrimaryLabel({
        id: "gpt-4o",
        fullModel: "openai/gpt-4o",
        providerAlias: "openai",
        name: "gpt-4o",
      }),
      "gpt-4o"
    );
  });

  it("falls back to the full id when no alias is known", () => {
    assert.equal(
      modelPrimaryLabel({ id: "m", fullModel: "x/m", providerAlias: "" }),
      "x/m"
    );
  });

  it("two providers exposing the same model id both show the bare id", () => {
    const label = modelPrimaryLabel({
      id: "minimax/minimax-m3:free",
      fullModel: "other-node/minimax/minimax-m3:free",
      providerAlias: "other-node",
    });
    assert.equal(label, "minimax/minimax-m3:free");
  });
});

describe("hasDistinctDisplayName", () => {
  it("rejects empty and id-duplicating names", () => {
    assert.equal(hasDistinctDisplayName("", { id: "a" }), false);
    assert.equal(hasDistinctDisplayName("a", { id: "a" }), false);
    assert.equal(hasDistinctDisplayName("x/a", { id: "a", fullModel: "x/a" }), false);
  });

  it("accepts a real label", () => {
    assert.equal(hasDistinctDisplayName("MiniMax M3", { id: "minimax/minimax-m3:free" }), true);
  });
});
