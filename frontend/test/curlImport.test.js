import test from "node:test";
import assert from "node:assert/strict";
import { parseCurlImport } from "../src/shared/utils/curlImport.js";

test("parses standard quoted cURL and extracts endpoint, bearer key, and model", () => {
  const parsed = parseCurlImport(`curl 'https://api.example.com/v1/chat/completions' -X POST -H 'Authorization: Bearer secret-token' -H 'Content-Type: application/json' -d '{"model":"acme/model-x","messages":[]}'`);
  assert.equal(parsed.baseUrl, "https://api.example.com/v1");
  assert.equal(parsed.apiType, "chat");
  assert.equal(parsed.modelId, "acme/model-x");
  assert.equal(parsed.apiKey, "secret-token");
  assert.equal(parsed.hasCredentials, true);
});

test("parses multiline continuation and Responses endpoint without running input", () => {
  const parsed = parseCurlImport("curl --url https://host/gateway/v1/responses \\\n+    -H \"Authorization: Bearer key\" \\\n+    --data-raw '{\"model\":\"m1\",\"input\":\"hi\"}'");
  assert.equal(parsed.baseUrl, "https://host/gateway/v1");
  assert.equal(parsed.apiType, "responses");
  assert.equal(parsed.modelId, "m1");
});

test("extracts x-api-key credentials and masks secret-valued custom headers", () => {
  const parsed = parseCurlImport("curl https://gateway.test/tenant/v1/chat/completions -H 'x-api-key: private-value' -H 'X-Tenant-Key: tenant-secret'");
  assert.equal(parsed.baseUrl, "https://gateway.test/tenant/v1");
  assert.equal(parsed.apiKey, "private-value");
  assert.equal(parsed.headers["X-Tenant-Key"], "••••••");
  assert.deepEqual(parsed.customHeaderNames, ["x-api-key", "X-Tenant-Key"]);
});

test("reports unsupported options and malformed commands", () => {
  const parsed = parseCurlImport("curl https://host/v1/chat/completions --insecure -d '{\"model\":\"m\"}'");
  assert.ok(parsed.unsupported.some((warning) => warning.includes("--insecure")));
  assert.throws(() => parseCurlImport("curl 'https://host/v1"), /unmatched quote/i);
  assert.throws(() => parseCurlImport("curl file:///tmp/input"), /http\(s\)/i);
});

test("never executes shell substitutions", () => {
  globalThis.__curlImportExecuted = false;
  const parsed = parseCurlImport("curl https://host/v1/chat/completions -H 'X-Test: $(globalThis.__curlImportExecuted=true)' ");
  assert.equal(globalThis.__curlImportExecuted, false);
  assert.deepEqual(parsed.headers, { "X-Test": "$(globalThis.__curlImportExecuted=true)" });
  delete globalThis.__curlImportExecuted;
});
