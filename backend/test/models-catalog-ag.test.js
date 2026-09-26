/**
 * Catalog consistency tests: Antigravity models present in both the backend
 * executor-side catalog and the frontend display catalog, including the
 * requested gemini-3.7-flash tier entries.
 *
 * Run: node --test test/models-catalog-ag.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const { PROVIDER_MODELS } = await import("../open-sse/config/providerModels.js");

test("backend ag catalog contains the gemini-3.7-flash tier models", () => {
  const ag = PROVIDER_MODELS.ag || [];
  const ids = new Set(ag.map((m) => m.id));
  for (const id of ["gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"]) {
    assert.ok(ids.has(id), `backend catalog must contain ag/${id}`);
  }
});

test("frontend ag catalog matches backend ids for the 3.7 flash tiers", () => {
  const frontendSrc = readFileSync(
    path.join(root, "frontend/src/shared/config/providerModels.js"),
    "utf8"
  );
  for (const id of ["gemini-3.7-flash-low", "gemini-3.7-flash-medium", "gemini-3.7-flash-high"]) {
    assert.ok(frontendSrc.includes(`id: "${id}"`), `frontend catalog must contain ${id}`);
  }
});

test("3.7 tier names follow the existing tier display convention", () => {
  const ag = PROVIDER_MODELS.ag || [];
  const low = ag.find((m) => m.id === "gemini-3.7-flash-low");
  const medium = ag.find((m) => m.id === "gemini-3.7-flash-medium");
  const high = ag.find((m) => m.id === "gemini-3.7-flash-high");
  assert.equal(low?.name, "Gemini 3.7 Flash (Low)");
  assert.equal(medium?.name, "Gemini 3.7 Flash (Medium)");
  assert.equal(high?.name, "Gemini 3.7 Flash (High)");
});

test("no duplicate ids inside the ag catalog", () => {
  const ag = PROVIDER_MODELS.ag || [];
  const ids = ag.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length, "ag catalog must not contain duplicate ids");
});
