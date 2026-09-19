# Adding an OAuth Provider to 9Router V3

This guide explains how to add a new OAuth provider using the registry workflow.
Read it together with the capability matrix from `GET /api/oauth/providers`.

## 1. Verify the protocol first

Before writing code, verify against official provider documentation:

- Authorization endpoint URL (must be `https:`)
- Token endpoint URL (must be `https:`)
- Supported flows: authorization-code + PKCE, device grant, or token import
- Whether a refresh flow exists
- Whether a model-listing API exists
- Scopes, if any

Do NOT invent endpoints, scopes, or response formats. If the protocol cannot
be verified, register the provider as non-OAuth (see OpenRouter in
`backend/src/lib/oauth/registry.js`) or do not register it.

## 2. Files to create

| File | Purpose |
|---|---|
| `backend/src/lib/oauth/services/<id>.js` | Adapter: authorize, exchange, refresh, discovery helpers |
| `backend/src/lib/oauth/constants/oauth.js` | Add `<ID>_CONFIG` (client id, endpoints — never secrets) |
| Tests in `backend/test-oauth-registry.js` | Manifest + flow coverage |

## 3. Files to modify

| File | Change |
|---|---|
| `backend/src/lib/oauth/providers.js` | Add entry to `PROVIDERS` with `config`, `flowType`, `buildAuthUrl`, `exchangeToken`, `mapTokens`, optional `refreshTokens`, `prepareConfig`, `postExchange` |
| `backend/src/lib/oauth/registry.js` | Add `META[<id>]` manifest (display name, docs URL, discovery, notices) |
| Frontend modal | `OAuthModal` works generically; add a dedicated modal only for non-standard UX |

## 4. Manifest schema (`META`)

```js
"<id>": {
  displayName: "Human Name",       // required
  description: "...",              // required, no credentials
  docsUrl: "https://...",          // required https URL or null
  apiFormats: ["openai"],          // subset of openai/anthropic/native
  discovery: { supported: bool, via: "native" | "static" },
  extras: {                        // only verified capabilities
    proxyCallback: bool,           // localhost proxy server flow
    manualCode: bool,              // paste authorization code
    tokenImport: bool,             // paste access token
    cookieImport: bool,            // browser-cookie import
    directCodePaste: bool,         // auth code without PKCE
  },
  notice: "...",                   // optional user-facing warning or null
}
```

Capabilities `pkce`, `deviceCode`, `authCode`, `manualCallback`, and
`tokenRefresh` are derived at runtime from the live adapter (`flowType` and
refresh functions) so manifests cannot drift. Run
`node --test test-oauth-registry.js` (via tsx — see below) to validate.

## 5. Required adapter interface (`PROVIDERS[<id>]`)

- `config` — static config object (endpoints, public client id)
- `flowType` — `"authorization_code_pkce"` | `"authorization_code"` | `"device_code"` | `"import_token"`
- `buildAuthUrl(config, redirectUri, state, codeChallenge?, meta?)` — authorization-code flows
- `exchangeToken(config, code, redirectUri, codeVerifier?, state?, meta?)` — code exchange
- `mapTokens(tokens, extra?)` — normalize to `{ accessToken, refreshToken?, expiresIn?, email?, ... }`
- `refreshTokens(...)` — optional; enables the `tokenRefresh` capability
- `prepareConfig(config, meta)` — optional; e.g. GitLab custom base URL (validate `https:` + allowlist hosts)
- `postExchange(tokens)` — optional enrichment
- Device flows: `requestDeviceCode` / `pollForToken` shapes per existing providers (qoder, qwen)

Unsupported capabilities must be left undeclared — never advertise a flow
the adapter does not implement.

## 6. Authentication flow selection

| Flow | When to use |
|---|---|
| `authorization_code_pkce` | Provider supports S256 PKCE (preferred) |
| `authorization_code` | Provider requires plain auth code (e.g. Cline) |
| `device_code` | CLI-style providers with verification URI |
| `import_token` | Provider gives tokens/cookies out-of-band (Cursor, iFlow cookie) |

Every flow must: use `crypto.randomBytes` state/PKCE (`lib/oauth/utils/pkce.js`),
bind sessions server-side (`lib/oauth/utils/server.js`), expire sessions,
reject code reuse, and never log codes, tokens, or cookies.

## 7. Credential storage rules

- Store connections via `createProviderConnection()` (`models/index.js`).
- Never log `accessToken`, `refreshToken`, `apiKey`, `cookie`, or `code`.
- Never return credentials in GET responses; exchange endpoints return only
  `{ id, provider, email, displayName }`.
- Dashboard auth (`authMiddleware`) already protects all `/api/*` routes.

## 8. Model discovery requirements

- Prefer the shared route `GET /api/providers/:connectionId/models`.
- If the provider needs custom logic, add a `customResolver` entry in that
  route file following the kiro/qoder pattern (refresh-on-401, persist
  refreshed credentials).
- Normalize with `normalizeDiscoveredModel()` semantics: explicit ids only,
  never invent ids from display names.
- Declare `discovery: { supported: false }` when no listing API exists.

## 9. Testing requirements

- Registry: manifest validation, capability honesty, no-secret JSON.
- Flow: auth-URL generation offline, PKCE linkage, unknown-provider rejection.
- Provider: exchange + refresh against recorded fixtures or sandbox creds —
  never commit real tokens.
- Run: `npx tsx --test test-oauth-registry.js` from `backend/`
  (tsx is required: the OAuth chain uses the `@/` path alias).
- Also run `node --test test-model-batch.js test-model-sync.js`.

## 10. Security checklist

- [ ] Endpoints verified from official docs, `https:` enforced
- [ ] `state` validated, sessions expire, no code reuse
- [ ] No tokens/cookies/keys in logs or GET responses
- [ ] Custom base URLs validated (protocol + host allowlist) — SSRF
- [ ] No shell execution with user input
- [ ] Registry validation passes (`validateRegistry()` returns `[]`)
- [ ] Dashboard reachable only behind dashboard auth

## 11. Environment variables

No per-provider secrets are stored in code or manifests. User credentials live
in provider connections. Deployment-level settings (`JWT_SECRET`,
`INITIAL_PASSWORD`, `DATABASE_URL`, proxy vars) are unchanged.
