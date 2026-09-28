// Client mirror tests for the discovered-model workflow.
// Run: npm test  (node --test, no extra dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  partitionDiscovered,
  filterDiscovered,
  resolveBulkAdd,
  resolveDisableNotAdded,
  resolveAutoAdd,
} from "../src/shared/utils/discoveredModels.js";

describe("discoveredModels client mirror", () => {
  it("separates added from discovered and excludes stale", () => {
    const { added, discovered } = partitionDiscovered({
      catalog: [{ id: "a" }, { id: "b" }, { id: "s", stale: true }],
      storageAlias: "p",
      modelAliases: { a: "p/a" },
      hardcodedIds: [],
    });
    assert.deepEqual(added.map((r) => r.id), ["a"]);
    assert.deepEqual(discovered.map((r) => r.id), ["b"]);
  });

  it("filters combine (search + status + price) and counts match rows", () => {
    const { discovered } = partitionDiscovered({
      catalog: [{ id: "w" }, { id: "bad" }, { id: "fresh" }],
      storageAlias: "p",
      modelAliases: {},
      hardcodedIds: [],
    });
    const testResults = { w: "ok", bad: "error" };
    const out = filterDiscovered(discovered, { search: "", status: "working", price: "all", testResults, disabledIds: [] });
    assert.deepEqual(out.rows.map((r) => r.id), ["w"]);
    assert.equal(out.counts.working, 1);
    const search = filterDiscovered(discovered, { search: "fresh", status: "all", price: "all", testResults, disabledIds: [] });
    assert.deepEqual(search.rows.map((r) => r.id), ["fresh"]);
  });

  it("bulk add + disable-not-added + auto-add agree", () => {
    const { discovered } = partitionDiscovered({
      catalog: [{ id: "w" }, { id: "bad" }, { id: "fresh" }],
      storageAlias: "p",
      modelAliases: {},
      hardcodedIds: [],
    });
    const testResults = { w: "ok", bad: "error" };
    const filtered = filterDiscovered(discovered, { status: "all", price: "all", testResults, disabledIds: [] }).rows;
    assert.deepEqual(resolveBulkAdd(filtered).targets.sort(), ["bad", "fresh", "w"]);
    const auto = resolveAutoAdd({ discoveredRows: discovered, testResults, disabledIds: [], policy: "working-disable-failed" });
    assert.deepEqual(auto.toAdd, ["w"]);
    assert.deepEqual(auto.toDisable, ["bad"]);
    assert.deepEqual(resolveDisableNotAdded(filtered.filter((r) => r.id !== "w"), { disabledIds: [], hardcodedIds: [] }).sort(), ["bad", "fresh"]);
  });

  it("untested models are never working or error", () => {
    const { discovered } = partitionDiscovered({
      catalog: [{ id: "fresh" }],
      storageAlias: "p",
      modelAliases: {},
      hardcodedIds: [],
    });
    const working = filterDiscovered(discovered, { status: "working", testResults: {}, disabledIds: [] });
    const error = filterDiscovered(discovered, { status: "error", testResults: {}, disabledIds: [] });
    assert.equal(working.rows.length, 0);
    assert.equal(error.rows.length, 0);
  });
});
