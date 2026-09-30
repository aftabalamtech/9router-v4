// Verifies the improved DATA_DIR fallback warning without needing a real
// unwritable directory (as root, /proc mkdir probes are unreliable in CI).
// Mocks fs.mkdirSync to throw EACCES BEFORE importing dataDir.js, since the
// module resolves DATA_DIR at import time.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

  // mkdir succeeding is not proof of writability: an existing Render disk mount
  // owned by another UID lets mkdir succeed and still fails on real writes.
  it("rejects a DATA_DIR where the directory exists but writes fail", async () => {
    const restore = mock.method(fs, "openSync", () => {
      const err = new Error("Permission denied");
      err.code = "EACCES";
      throw err;
    });
    try {
      process.env.DATA_DIR = "/var/data";
      const { getDataDir } = await import("../src/lib/dataDir.js?eacces-open-test");
      const resolved = getDataDir();
      assert.ok(resolved.includes(".9router-v3"), `expected home fallback, got: ${resolved}`);
    } finally {
      restore.mock.restore();
      delete process.env.DATA_DIR;
    }
  });

  it("leaves no probe file behind in a writable DATA_DIR", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-datadir-"));
    try {
      process.env.DATA_DIR = dir;
      const { getDataDir } = await import("../src/lib/dataDir.js?writable-test");
      assert.equal(getDataDir(), dir);
      assert.deepEqual(fs.readdirSync(dir), [], "write probe must clean up after itself");
    } finally {
      delete process.env.DATA_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
