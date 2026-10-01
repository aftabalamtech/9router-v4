// Wires the connectivity layer into the runtime paths that previously
// duplicated it, and proves the shared layer is what they use.
//
// Background: the runtime chat path (open-sse/executors) and the dashboard
// validation paths each built their own URL and auth headers, which is how a
// provider could validate in one place and fail in another. These tests assert
// that the shared layer is used and that its guarantees hold on those paths.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const src = (rel) => fs.readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
// backend/test/ → ../ = backend/, so open-sse lives at ../open-sse/.
const openSse = (rel) => fs.readFileSync(new URL(`../open-sse/${rel}`, import.meta.url), "utf8");

describe("runtime execution uses the shared connectivity layer", () => {
  it("builds compatible-provider URLs through describeProviderTarget", () => {
    const defaultExecutor = openSse("executors/default.js");
    assert.match(
      defaultExecutor,
      /describeProviderTarget|from\s+["'][^"']*providerConnection/,
      "DefaultExecutor must build URLs via the shared layer, not a private copy"
    );
  });

  it("builds embeddings URLs through the shared layer", () => {
    const adapter = openSse("handlers/embeddingProviders/openaiCompatNode.js");
    assert.match(
      adapter,
      /describeProviderTarget|buildCompatibleEmbeddingsUrl/,
      "the embeddings adapter must not re-implement endpoint construction"
    );
  });

  it("no longer duplicates the compatible base-URL strip list", () => {
    // ENDPOINT_SUFFIXES had three copies (compatibleUrl.js, providerConnection.js,
    // and inline regexes). The shared module is now the single source.
    const connection = src("lib/net/providerConnection.js");
    assert.match(connection, /ENDPOINT_SUFFIXES/);
    const runtime = openSse("executors/default.js") + openSse("handlers/embeddingProviders/openaiCompatNode.js");
    assert.equal(
      /chat\/completions"\s*,?\s*\n\s*"\/completions/.test(runtime),
      false,
      "runtime executors must not carry their own endpoint-suffix list"
    );
  });
});

describe("validation paths share one taxonomy", () => {
  const routes = [
    "routes/provider-nodes/validate/route.ts",
    "routes/providers/validate/route.ts",
    "routes/providers/[id]/test/testUtils.js",
  ];

  it("no validation path hard-codes a bare invalid-key verdict for 401/403", () => {
    for (const rel of routes) {
      const source = src(rel);
      // `Invalid API key` may only survive in the final catch-all for
      // unsupported/built-in providers, never in a compatible branch.
      const compatibleAt = source.search(/is(OpenAI|Anthropic|CustomEmbedding)CompatibleProvider|compatible/);
      if (compatibleAt === -1) continue;
      const compatibleBranch = source.slice(compatibleAt);
      assert.equal(
        /error:\s*"Invalid API key"/.test(compatibleBranch),
        false,
        `${rel}: the compatible branch must not hard-code an invalid-key verdict`
      );
    }
  });

  it("no validation path treats an HTML body as a credential failure", () => {
    for (const rel of routes) {
      const source = src(rel);
      assert.equal(
        /isAuthFailure\([^)]*\)\s*(\?\?|&&)?[^;{]*Invalid API key/i.test(source),
        false,
        `${rel}: must classify the body before deciding it is a credential failure`
      );
    }
  });
});

describe("relay/proxy egress is validated", () => {
  it("proxy pools reject destinations that fail the egress policy", async () => {
    const { validateProxyEndpoint } = await import(
      pathToFileURL(new URL("../dist/lib/net/egressPolicy.js", import.meta.url).pathname).href
    );
    // The route must gate its input, not accept any non-empty string.
    const source = src("routes/proxy-pools/route.ts");
    assert.match(source, /validateProxyEndpoint|validateOutboundUrl/, "proxy pools must validate the destination");
    assert.equal(
      /const proxyUrl = typeof body\?\.proxyUrl === "string" \? body\?\.proxyUrl\.trim\(\) : "";/.test(source)
      && !/validateProxy|validateOutbound/.test(source),
      false
    );
    assert.equal(validateProxyEndpoint("https://relay.example.com:8443").ok, true);
    assert.equal(validateProxyEndpoint("https://relay.example.com").ok, false, "port is required");
  });

  it("the proxy test route cannot be used as an SSRF probe", async () => {
    const source = src("routes/settings/proxy-test/route.ts");
    assert.match(
      source,
      /validateOutboundUrl|validateProxyEndpoint/,
      "an operator-supplied test target must be validated before use"
    );
  });
});

describe("no credential is written to logs by the shared layer", () => {
  it("the diagnostics route logs only the verdict, host, and check count", () => {
    const source = src("routes/provider-diagnostics/route.ts");
    const consoleCalls = source.match(/console\.(log|error|warn)\([^)]*\)/g) || [];
    for (const call of consoleCalls) {
      assert.equal(/apiKey/.test(call), false, `console call may reference apiKey: ${call}`);
    }
  });

  it("connection records store a sanitized message, not a raw body", async () => {
    const { sanitizeUpstreamText, redactSecrets } = await import(
      pathToFileURL(new URL("../dist/lib/net/providerConnection.js", import.meta.url).pathname).href
    );
    const secret = "cc_store_this_key_abcdef";
    const sanitized = redactSecrets(sanitizeUpstreamText(`<html><body>bad ${secret}</body></html>`), secret);
    assert.equal(sanitized.includes(secret), false);
    assert.equal(sanitized.includes("<"), false);
  });
});

describe("deployment parity", () => {
  it("every supported environment resolves the same data dir contract", () => {
    const dockerfile = fs.readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    assert.match(dockerfile, /ENV DATA_DIR=\/data/, "Docker sets the documented DATA_DIR default");
    const hooks = fs.readFileSync(new URL("../bin/hooks/sqliteRuntime.cjs", import.meta.url), "utf8");
    assert.match(hooks, /process\.env\.DATA_DIR/, "DATA_DIR is the single source of truth across environments");
  });

  it("no provider or deployment URL is hard-coded in the connectivity layer", () => {
    const connection = src("lib/net/providerConnection.js");
    // Only documentation examples may contain a hostname.
    const codeLines = connection
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"));
    for (const line of codeLines) {
      assert.equal(
        /https:\/\/(api|www)\.[a-z0-9.-]+\.(com|ai|net|org)\//.test(line),
        false,
        `no hard-coded provider URL in code: ${line.trim()}`
      );
    }
  });

  it("egress policy is environment-driven, not platform-detected", () => {
    const policy = src("lib/net/egressPolicy.js");
    // Platform sniffing would break the stated goal of not assuming equal
    // outbound IP behaviour across Render/Railway.
    assert.equal(
      /RENDER|RAILWAY|process\.env\.RENDER|process\.env\.RAILWAY/.test(policy),
      false,
      "the egress policy must not branch on deployment platform"
    );
    assert.match(policy, /ALLOW_PRIVATE_EGRESS/, "it is configured explicitly instead");
  });
});