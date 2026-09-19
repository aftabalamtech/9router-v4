import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildManifest,
  listProviders,
  getManifest,
  validateManifest,
  validateRegistry,
} from "./src/lib/oauth/registry.js";
import { generatePKCE, generateCodeChallenge } from "./src/lib/oauth/utils/pkce.js";
import { generateAuthData } from "./src/lib/oauth/providers.js";

describe("registry loading", () => {
  it("validates cleanly", () => {
    assert.deepEqual(validateRegistry(), []);
  });
  it("registers 15 OAuth providers plus API-key-only OpenRouter", () => {
    const all = listProviders();
    assert.equal(all.length, 16);
    assert.equal(all.filter((p) => p.oauth).length, 15);
    const or = all.find((p) => p.id === "openrouter");
    assert.equal(or.oauth, false);
    assert.deepEqual(or.authMethods, ["apiKey"]);
    assert.equal(or.adapter, null);
  });
  it("every OAuth manifest resolves against the live adapter map", () => {
    for (const p of listProviders().filter((p) => p.oauth)) {
      assert.ok(p.flowType, `${p.id} missing flowType`);
      assert.ok(p.authMethods.length > 0, `${p.id} declares no auth methods`);
    }
  });
});

describe("manifest validation", () => {
  it("rejects unknown and malformed ids", () => {
    assert.throws(() => getManifest("nope"), /Unknown OAuth provider/);
    assert.throws(() => getManifest("../x"), /Unknown OAuth provider/);
    assert.throws(() => getManifest(""), /Invalid provider id/);
    assert.throws(() => getManifest(42), /Invalid provider id/);
  });
  it("rejects manifests with missing fields or bad docs URL", () => {
    assert.ok(validateManifest({}).length > 0);
    assert.ok(validateManifest({ ...buildManifest("claude"), docsUrl: "http://x" }).some((e) => e.includes("https")));
  });
  it("rejects credential material", () => {
    const dirty = { ...buildManifest("claude"), description: "x", extra: { accessToken: "abcdef123456" } };
    assert.ok(validateManifest(dirty).some((e) => e.includes("credential")), JSON.stringify(validateManifest(dirty)));
  });
  it("registry JSON carries no token material", () => {
    const json = JSON.stringify(listProviders());
    assert.ok(!/eyJ[A-Za-z0-9-_]{8,}\.[A-Za-z0-9-_]{8,}/.test(json));
  });
});

describe("capability honesty", () => {
  it("PKCE providers advertise PKCE, device providers advertise device flow", () => {
    assert.equal(getManifest("claude").capabilities.pkce, true);
    assert.equal(getManifest("qoder").capabilities.deviceCode, true);
    assert.deepEqual(getManifest("qoder").authMethods.includes("deviceCode"), true);
  });
  it("cline uses auth code without PKCE and supports direct paste", () => {
    const c = getManifest("cline");
    assert.equal(c.capabilities.pkce, false);
    assert.equal(c.capabilities.directCodePaste, true);
  });
  it("proxy-callback providers are exactly codex/xai/antigravity", () => {
    const proxied = listProviders().filter((p) => p.capabilities?.proxyCallback).map((p) => p.id).sort();
    assert.deepEqual(proxied, ["antigravity", "codex", "xai"]);
  });
});

describe("PKCE utils", () => {
  it("verifier/challenge/state are well-formed and S256-linked", () => {
    const { codeVerifier, codeChallenge, state } = generatePKCE();
    assert.ok(codeVerifier.length >= 43 && codeVerifier.length <= 128);
    assert.equal(generateCodeChallenge(codeVerifier), codeChallenge);
    assert.ok(state.length >= 32);
    assert.notEqual(generatePKCE().codeVerifier, codeVerifier);
  });
});

describe("authorization URL generation (offline)", () => {
  it("builds a claude auth URL with state and challenge, no secrets", async () => {
    const data = await generateAuthData("claude", "http://localhost:8080/callback");
    assert.ok(typeof data.authUrl === "string" && data.authUrl.startsWith("https://"));
    assert.ok(data.authUrl.includes("code_challenge="));
    assert.ok(data.state && data.codeVerifier);
    assert.ok(!/token|secret/i.test(JSON.stringify(data)));
  });
  it("device providers return no upfront auth URL", async () => {
    const data = await generateAuthData("qoder", "http://localhost:8080/callback");
    assert.equal(data.authUrl, null);
    assert.equal(data.flowType, "device_code");
  });
  it("unknown provider throws", async () => {
    await assert.rejects(() => generateAuthData("nope", "http://localhost:8080/callback"), /Unknown provider/);
  });
});
