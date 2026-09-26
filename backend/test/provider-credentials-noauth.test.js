/**
 * Provider credential resolution (the other half of the Playground failure).
 *
 * A provider declared `noAuth: true` (OpenCode Free / "oc") must resolve a
 * usable credential even when the user has stored zero connections — no API
 * key required. A provider that genuinely needs credentials must still resolve
 * to nothing, so it keeps failing loudly instead of silently sending an
 * unauthenticated request.
 *
 * Runs against a throwaway SQLite DATA_DIR to stay off the developer's real DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-credentials-"));
process.env.DATA_DIR = dataDir;
delete process.env.DATABASE_URL;

const { getProviderCredentials } = await import("../src/sse/services/auth.js");
const {
  createProviderConnection,
  deleteProviderConnectionsByProvider,
} = await import("../src/lib/localDb.js");

test("noAuth provider resolves a virtual credential with zero connections", async () => {
  const creds = await getProviderCredentials("opencode");
  assert.ok(creds, "OpenCode Free must resolve without any stored connection");
  assert.equal(creds.id, "noauth");
  assert.equal(creds.accessToken, "public");
  assert.equal(creds.isActive, true);
});

test("the alias 'oc' resolves exactly like the provider id", async () => {
  const byAlias = await getProviderCredentials("oc");
  const byId = await getProviderCredentials("opencode");
  assert.ok(byAlias, "alias must resolve");
  assert.equal(byAlias.id, byId.id);
  assert.equal(byAlias.accessToken, byId.accessToken);
});

test("credentialed provider still resolves to nothing without a connection", async () => {
  assert.equal(await getProviderCredentials("openrouter"), null);
});

test("a stored connection is preferred over the virtual no-auth credential", async () => {
  await createProviderConnection({
    provider: "opencode",
    authType: "apikey",
    name: "opencode-free-key",
    apiKey: "oc-test-key",
    isActive: true,
    priority: 1,
  });

  const creds = await getProviderCredentials("oc");
  assert.ok(creds);
  assert.notEqual(creds.id, "noauth");
  assert.equal(creds.apiKey, "oc-test-key");

  await deleteProviderConnectionsByProvider("opencode");
  const afterCleanup = await getProviderCredentials("oc");
  assert.equal(afterCleanup.id, "noauth");
});

// NOTE: the throwaway DATA_DIR is intentionally left behind — the SQLite
// adapter flushes on a debounced timer, so removing it mid-run only produces
// spurious write errors. The OS temp dir is cleaned up by the system.
