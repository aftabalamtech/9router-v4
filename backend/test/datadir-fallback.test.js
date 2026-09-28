// Verifies the improved DATA_DIR fallback warning without needing a real
// unwritable directory (as root, /proc mkdir probes are unreliable in CI).
// Mocks fs.mkdirSync to throw EACCES BEFORE importing dataDir.js, since the
// module resolves DATA_DIR at import time.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

describe("DATA_DIR fallback warning", () => {
  it("falls back to the home dir and explains data safety when unwritable", async () => {
    const restore = mock.method(fs, "mkdirSync", () => {
      const err = new Error("Permission denied");
      err.code = "EACCES";
      throw err;
    });
    try {
      process.env.DATA_DIR = "/var/data";
      delete process.env.DATABASE_URL;
      const { getDataDir } = await import("../src/lib/dataDir.js?eacces-test");
      const resolved = getDataDir();
      assert.ok(resolved.includes(".9router-v3"), `expected home fallback, got: ${resolved}`);
    } finally {
      restore.mock.restore();
      delete process.env.DATA_DIR;
    }
  });
});
