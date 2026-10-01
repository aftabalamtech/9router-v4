# Provider connectivity & diagnostics

Reference for `backend/src/lib/net/providerConnection.js`, `egressPolicy.js`, and
`POST /api/provider-diagnostics`.

## Why this exists

9Router had four independent implementations of "talk to an OpenAI-compatible
provider". Each built its own URL, its own auth headers, its own timeout, and
its own failure message. They disagreed, which produced reports that were
impossible to reproduce — a provider that validated in one screen and failed in
another, with an "Invalid API key" message that was frequently wrong.

This document describes the shared layer that replaced them, how to diagnose a
provider that is blocked on a specific host, and the rules the code enforces.

## Architecture

```
UI (EditCompatibleNodeModal)
  └─> POST /api/provider-diagnostics        ← four independent checks
        └─> lib/net/providerConnection.js   ← the single connectivity layer
              ├─ describeProviderTarget()   endpoint construction
              ├─ authHeadersFor()            auth headers
              ├─ providerFetch()             timeout + redirect policy
              ├─ classifyUpstreamResponse()  failure taxonomy
              └─ redactSecrets()             redaction

Any outbound call ─> lib/net/egressPolicy.js  (destination validation)
Runtime chat ──────> open-sse/executors/default.js ──> describeProviderTarget()
```

`describeProviderTarget()` is used by the diagnostics endpoint *and* the runtime
executor, so a URL that passes a test is the URL that gets called.

## Failure taxonomy

| Category | Meaning | Usually means |
|---|---|---|
| `invalid_credentials` | Provider rejected the key | The key is wrong, revoked, or expired |
| `permission_denied` | 403 that does not name a credential | Account/plan/IP restriction |
| `security_challenge` | Edge served an interactive challenge | Upstream network/IP block |
| `rate_limited` | 429 | Throttling or Cloudflare error 1015 |
| `upstream_server_error` | 5xx | Provider outage |
| `invalid_endpoint` | HTML page, redirect, 404/405 | Wrong base URL, or a website not an API |
| `dns_error` | Hostname did not resolve | DNS or typo |
| `tls_error` | Certificate validation failed | Cert chain, clock, or interception |
| `timeout` | No answer within the deadline | Slow or filtered upstream |
| `invalid_response` | 2xx that is not usable JSON | Wrong API type or endpoint |
| `unsupported_operation` | Provider lacks the capability | No `/models` route, etc. |

Rules the classifier enforces:

- **An HTML body is never `invalid_credentials`.** It is classified by content:
  an edge-challenge fingerprint gives `security_challenge`, anything else gives
  `invalid_endpoint`.
- **A 429 is always `rate_limited`**, never a challenge. Cloudflare error 1015
  ("rate limited") is plain text and would otherwise be misread as a block.
- **A 403 is only a credential failure when the body says so.** "Forbidden:
  requests from this network are blocked" is an IP block. The word `forbidden`
  is deliberately excluded from the credential vocabulary.
- **A redirect is reported, never followed** (see below).

## Request policy

`providerFetch()` enforces:

- **A hard deadline** on every outbound call. Implemented with an explicit
  `AbortController` and a ref'd timer rather than `AbortSignal.timeout()`,
  because the latter does not keep the event loop alive and could let the
  process exit mid-request.
- **`redirect: "manual"`.** Following a redirect would move the request *and its
  Authorization header* to a host the operator never configured, and would hide
  the real final URL. The `Location` is surfaced instead.
- **Body read exactly once.** A response body is classified from a single read;
  a second read throws and turns a diagnosis into a 500.

## Secret handling

`redactSecrets()` runs on every string that can reach a client, a log, or the
database. It removes:

- `Authorization: Bearer <token>`
- `api_key=…`, `access_token=…`, `token=…`, `secret=…`, `password=…`
- provider key shapes (`sk-`, `cc_`, `pk_`, `ghp_`, `xox*-`)
- the specific credential passed in for that request

Raw upstream bodies are available to internal callers as `diagnostic.text` /
`diagnostic.json` (needed to read a model catalog), and are excluded by
`publicDiagnostic()`, which is the client boundary.

## Egress policy

`validateOutboundUrl()` gates every user-configured destination.

**Always blocked**, regardless of configuration:

- cloud metadata endpoints (`169.254.169.254`, `metadata.google.internal`,
  `100.100.100.200`) — these return the host's own cloud credentials
- documentation IP ranges (RFC 5737)
- non-`http(s)` schemes, URLs with embedded credentials, control characters

**Blocked unless explicitly enabled**: loopback, private (RFC 1918), link-local,
and `.internal` hosts. Self-hosted gateways (`http://localhost:11434` for Ollama,
`http://192.168.1.10:8000`) are a supported 9Router deployment mode, so this is
opt-in rather than never:

```bash
# permit all private destinations (single-operator box)
ALLOW_PRIVATE_EGRESS=true

# or scope it
ALLOW_PRIVATE_EGRESS=localhost,192.168.1.0/24
```

`validateProxyEndpoint()` additionally requires HTTPS and an explicit port for a
relay/proxy destination, and refuses the metadata service.

### Optional egress gateway

9Router already supports an optional relay (Vercel / Cloudflare Worker / Deno)
via proxy pools, so no new gateway was built. What changed:

- proxy destinations are validated on create/update instead of accepting any
  non-empty string
- the proxy test endpoint validates a caller-supplied target, which was
  otherwise an SSRF probe
- relay credentials stay server-side; the browser never receives them

The relay is **opt-in per connection** and disabled by default. It is a routing
choice for an operator who has their own relay — not a mechanism for evading an
upstream block. 9Router does not bypass Cloudflare challenges, spoof browser
fingerprints, or automatically reroute blocked traffic elsewhere.

## Deployment configuration

The connectivity layer contains **no platform detection and no hard-coded
deployment URLs**. All environment-specific behaviour is explicit:

| Variable | Purpose | Default |
|---|---|---|
| `ALLOW_PRIVATE_EGRESS` | Permit self-hosted/private upstreams | disabled |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | Outbound proxy | none |
| `DATA_DIR` | SQLite, secrets, machine id | `/data` in Docker |
| `PORT` | Listen port (injected by PaaS) | `3001` |

The same code runs in local dev, the local production build, Docker, Render, and
Railway. **Do not assume platforms share outbound IP behaviour** — see below.

## Diagnosing a provider blocked on one host

The original symptom — works on Railway, fails on Render — is a network or
upstream-policy difference, not a configuration error. To establish it:

**1. Run the four checks** on the failing deployment
(`Providers → Edit provider → Run all (incl. chat)`), or:

```bash
curl -b cookies.txt -X POST "$DEPLOYMENT/api/provider-diagnostics" \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"openai-compatible-chat-<uuid>",
       "baseUrl":"https://provider.example/v1",
       "apiKey":"<key>","modelId":"<model>","includeChat":true}'
```

Read the verdict:

| Verdict | Category | Next step |
|---|---|---|
| `healthy` | – | Working; nothing to do |
| `usable` | – | Chat works, `/models` unavailable — add model IDs manually |
| `invalid_credentials` | `invalid_credentials` | The key itself — re-enter it |
| `blocked` | `security_challenge` / `permission_denied` | Upstream is refusing this host |
| `unreachable` | `dns_error` / `tls_error` / `timeout` / `network_error` | This host cannot reach the provider |

**2. Compare the two hosts with the same request.** Run the command above on
both deployments with identical input. If the working host returns
`invalid_credentials` (meaning the key is fine) while the failing host returns
`security_challenge`, the difference is upstream policy toward that host's
outbound IP.

**3. Check the evidence fields.** Each failing check returns `httpStatus`,
`headers` (`server`, `cf-ray`, `cf-mitigated`), `finalUrl`, and a sanitized
`responsePreview`. A `cf-ray` header plus `server: cloudflare` confirms the edge
produced the response.

**4. Confirm it is external.** The `security_challenge` remediation is the
provider allowlisting the host's egress IP. **Verify with the provider** — do
not treat a plausible-looking challenge page as proof of a block, and do not
attempt to solve, spoof, or route around it.

**5. Exclude local causes first**, in this order:
   - base URL missing `/v1` → the provider's marketing page answers with
     `200 text/html`, reported as `invalid_endpoint`
   - `security_challenge` on *both* hosts → the key or endpoint, not the network
   - rate limiting → `rate_limited`, wait rather than debug

**Only after steps 1–4** should application code be considered. If the provider
blocks Render-hosted clients and offers no remedy, that is an external
limitation to report, not a defect to keep patching.

## Testing

`npm test` runs everything deterministically. All upstream responses are mocked;
no test touches the network or a real credential.

- `backend/test/provider-diagnostics.test.js` — endpoint construction, the full
  taxonomy, redaction, the four checks, SSRF, and the fetch policy
- `backend/test/provider-egress-integration.test.js` — asserts the runtime
  executor and validation paths share the connectivity layer, that relay
  destinations are validated, and that no credential reaches a log

Live upstream behaviour is deliberately **not** asserted in CI: it is
non-deterministic and would produce false failures when a provider rate-limits
the runner.

## Migration

None. No schema change, no data migration. The new endpoint is additive and
opt-in; existing validation routes keep working and now share the same
taxonomy. `providerConnection.js` subsumes `upstreamDiagnostics.js` and
`networkFailure.js` — those two can be deleted once callers migrate (the current
validation routes still import them).