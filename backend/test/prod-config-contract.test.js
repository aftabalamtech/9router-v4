// Production-safety contracts for the Express app wiring.
//
// These assertions are static on purpose: they pin behaviour that only differs
// between local dev and a PaaS deployment (health probe contract, port binding,
// data directory defaults, CORS) and that a booting service can silently break.
//
// Run: npm test   (node --test, no extra dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SERVER_SRC = fs.readFileSync(
  new URL("../src/server.ts", import.meta.url),
  "utf8"
);
const DOCKERFILE = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");

test("health endpoint keeps answering 200 for platform probes", () => {
  const block = SERVER_SRC.slice(SERVER_SRC.indexOf('app.get("/api/health"'));
  const end = block.indexOf("});");
  const handler = block.slice(0, end);
  assert.ok(handler.includes("res.json("), "health must respond via res.json");
  assert.equal(
    /res\.status\(/.test(handler),
    false,
    "health must not answer 503 during DB init — Render marks a booting service as failed"
  );
});

test("health payload reports database readiness without exposing secrets", () => {
  assert.ok(SERVER_SRC.includes("database,"), "health must include database diagnostics");
  assert.equal(
    /process\.env\.DATABASE_URL\s*\}/.test(SERVER_SRC),
    false,
    "health must not echo DATABASE_URL"
  );
});

test("server binds the platform-injected port on all interfaces", () => {
  assert.ok(SERVER_SRC.includes("Number(process.env.PORT) || 3001"));
  assert.ok(SERVER_SRC.includes('app.listen(PORT, "0.0.0.0"'));
});

test("CORS reflects origins by default and only enforces an explicit allowlist", () => {
  assert.ok(SERVER_SRC.includes("process.env.CORS_ORIGINS"));
  assert.ok(
    SERVER_SRC.includes("configuredOrigins.size === 0"),
    "unset CORS_ORIGINS must keep same-origin/proxied traffic working"
  );
});

test("container image defaults DATA_DIR to the mount point and drops root privileges", () => {
  assert.ok(DOCKERFILE.includes("ENV DATA_DIR=/data"));
  assert.ok(DOCKERFILE.includes("USER appuser"));
  assert.ok(DOCKERFILE.includes("HEALTHCHECK"));
  // Railway rejects a bare VOLUME instruction; the mount is platform-provided.
  assert.equal(/^VOLUME\b/m.test(DOCKERFILE), false);
});

test("data dir probe removes its own probe file", () => {
  const source = fs.readFileSync(new URL("../src/lib/dataDir.js", import.meta.url), "utf8");
  assert.ok(source.includes("fs.unlinkSync(probe)"), "probe file must be removed");
});
