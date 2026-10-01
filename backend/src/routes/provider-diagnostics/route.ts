// POST /api/provider-diagnostics — one endpoint that answers "why doesn't this
// provider work?" with four INDEPENDENT results instead of a single pass/fail.
//
// WHY FOUR TESTS
// The original UI had one button, and it conflated four different questions:
//   1. credential  — is the key accepted?
//   2. models      — can we list the catalog?
//   3. chat        — can we actually run an inference?
//   4. network     — can this server reach the provider at all?
// A provider can pass 1 and fail 4 (DNS/TLS blocked), or pass 3 and fail 2
// (no /models route). Collapsing them into "Invalid" is what produced the
// unreproducible reports this endpoint replaces.
//
// Each check runs independently: one failing check never short-circuits the
// others, so the result set always describes the whole picture.
//
// SAFETY
//   • credentials are never echoed, not even in an upstream-echoed message
//   • the request body is size-limited before parsing
//   • the destination base URL is validated (scheme allowlist, no credentials in
//     the URL, no control characters); egress targets are NOT proxied through
//     a caller-supplied relay
//   • chat probes use a 1-token budget and are opt-in, because they cost money

import {
  FAILURE_CATEGORY,
  classifyUpstreamResponse,
  networkFailureDiagnostic,
  describeProviderTarget,
  authHeadersFor,
  providerFetch,
  describeFailure,
  remediationFor,
  sanitizeUpstreamText,
  redactSecrets,
  isCredentialFailure,
} from "../../lib/net/providerConnection.js";
import { validateOutboundUrl } from "../../lib/net/egressPolicy.js";

/** Hard ceiling on the request body, to bound memory on a public endpoint. */
const MAX_BODY_BYTES = 8 * 1024;

const CHECK_DEFAULTS = {
  credential: { timeoutMs: 12000 },
  models: { timeoutMs: 12000 },
  chat: { timeoutMs: 30000, maxTokens: 1 },
  network: { timeoutMs: 8000 },
};

/**
 * Validate the destination before any outbound request.
 *
 * Delegates to the shared egress policy so diagnostics cannot be used to probe
 * hosts that normal provider configuration could not reach (cloud metadata,
 * link-local metadata services, and — unless the operator opted in — private and
 * loopback addresses).
 */
function validateBaseUrl(raw) {
  const result = validateOutboundUrl(raw);
  // `reason` is already a complete sentence — do not append punctuation.
  if (!result.ok) return { error: result.reason };
  return { baseUrl: result.url.toString().replace(/\/+$/, "") };
}

async function runCheck({ name, url, method = "GET", headers, body, timeoutMs, apiKey, noun }) {
  const request = { url, method, hasAuth: Boolean(headers.Authorization || headers["x-api-key"]), apiKey };
  try {
    const response = await providerFetch(url, { method, headers, body, timeoutMs });
    const diagnostic = await classifyUpstreamResponse(response, request);
    // A non-JSON body is only reclassified as INVALID_RESPONSE when the
    // classifier could not name the failure itself. A category that already
    // describes the problem precisely — rate limited, security challenge, wrong
    // endpoint, rejected credential — is always kept, because "rate limited" is
    // far more actionable than "unusable response".
    const category = diagnostic.category !== FAILURE_CATEGORY.INVALID_RESPONSE
      ? diagnostic.category
      : FAILURE_CATEGORY.INVALID_RESPONSE;
    return {
      name,
      ok: response.ok && diagnostic.parsed && !diagnostic.redirected,
      category,
      httpStatus: diagnostic.status,
      credentialRejected: isCredentialFailure(diagnostic),
      message: describeFailure(diagnostic, { noun }),
      remediation: remediationFor(category),
      finalUrl: diagnostic.finalUrl,
      redirected: diagnostic.redirected,
      responsePreview: diagnostic.preview,
      upstreamDetail: diagnostic.detail,
      headers: diagnostic.diagnostics,
    };
  } catch (error) {
    const diagnostic = networkFailureDiagnostic(error, request);
    return {
      name,
      ok: false,
      category: diagnostic.category,
      httpStatus: null,
      credentialRejected: false,
      message: describeFailure(diagnostic, { noun }),
      remediation: remediationFor(diagnostic.category),
      finalUrl: url,
      redirected: false,
      responsePreview: "",
      upstreamDetail: diagnostic.detail,
      headers: {},
      errorName: error?.name || "Error",
    };
  }
}

/**
 * Models a request body that is minimal and provider-agnostic. Some gateways
 * reject `/models` but serve chat, so this is always attempted when a model id
 * is available.
 */
function chatProbeBody(modelId, apiType) {
  if (apiType === "responses") {
    return JSON.stringify({
      model: modelId,
      input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }],
      max_output_tokens: 1,
      stream: false,
    });
  }
  return JSON.stringify({
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  });
}

/**
 * Pull model ids out of a catalog body.
 *
 * Providers disagree on the envelope, so all the common shapes are accepted.
 * Returns `null` when the body is not a recognizable catalog — that is what
 * distinguishes "no models endpoint" from "an empty catalog".
 *
 * @param {string|object} body raw text or already-parsed JSON
 * @returns {string[]|null}
 */
function extractModelIds(body) {
  let data = body;
  if (typeof body === "string") {
    try {
      data = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!data) return null;

  const list = Array.isArray(data) ? data : (data.data ?? data.models ?? data.results);
  if (!Array.isArray(list)) return null;

  return list
    .map((entry) => (typeof entry === "string" ? entry : entry?.id || entry?.model || entry?.name))
    .filter((id) => typeof id === "string" && id.length)
    .slice(0, 500);
}

export async function POST_handler(req, res) {
  try {
    // Bound the body before parsing it.
    const declared = Number(req.headers?.["content-length"] || 0);
    if (declared > MAX_BODY_BYTES) {
      return res.status(413).json({ error: "Request body too large" });
    }

    const body = req.body || {};
    const providerId = String(body.providerId || body.provider || "");
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const apiType = body.apiType === "responses" ? "responses" : "chat";
    const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";

    const urlCheck = validateBaseUrl(body.baseUrl);
    if (urlCheck.error) return res.status(400).json({ error: urlCheck.error });

    const target = describeProviderTarget({ providerId, baseUrl: urlCheck.baseUrl, apiKey });
    if (target.error) return res.status(400).json({ error: target.error });

    // A chat probe costs tokens, so it only runs when explicitly requested and a
    // model is known. Everything else is free and always runs.
    const runChat = body.includeChat === true && Boolean(modelId);

    const headers = authHeadersFor({ family: target.family || "openai", apiKey });
    const jsonHeaders = { ...headers, "Content-Type": "application/json" };
    const noun = target.baseUrl.replace(/^https?:\/\//, "").split("/")[0] || "The provider";

    const checks = [];

    // 1. Network reachability — a plain GET, no credential, no model list.
    //    Establishes whether this host can complete a request at all, which is
    //    the question that separates "bad key" from "blocked network".
    const networkCheck = await runCheck({
      name: "network",
      url: target.urls.models,
      method: "GET",
      headers: {},
      timeoutMs: CHECK_DEFAULTS.network.timeoutMs,
      noun,
    });
    // A 401 here is the *expected* answer for an unauthenticated probe: it
    // proves DNS, TLS, routing and the HTTP round-trip all work. Only a
    // transport failure means "unreachable".
    const reached = networkCheck.httpStatus !== null;
    networkCheck.ok = reached;
    if (reached) {
      networkCheck.message = `${noun} is reachable from this server (HTTP ${networkCheck.httpStatus} to an unauthenticated probe).`;
      networkCheck.remediation = "No action needed — network path works. See the credential result below.";
      // An unauthenticated 401 is not evidence about the key, so clear the
      // inherited credential verdict rather than reporting it twice.
      if (networkCheck.category === FAILURE_CATEGORY.INVALID_CREDENTIALS) {
        networkCheck.category = FAILURE_CATEGORY.INVALID_RESPONSE;
        networkCheck.credentialRejected = false;
      }
    }
    checks.push(networkCheck);

    // 2. Credential validation — same endpoint WITH the credential. Compared
    //    against check 1, this isolates the credential as the only variable.
    const credentialCheck = await runCheck({
      name: "credential",
      url: target.urls.models,
      method: "GET",
      headers,
      timeoutMs: CHECK_DEFAULTS.credential.timeoutMs,
      apiKey,
      noun,
    });
    if (credentialCheck.ok) {
      credentialCheck.message = `${noun} accepted the credential.`;
    } else if (credentialCheck.category === FAILURE_CATEGORY.INVALID_CREDENTIALS) {
      // Already the right message.
    } else if (networkCheck.ok && !networkCheck.credentialRejected) {
      // The unauthenticated request got a *different* answer than the
      // authenticated one — the key changed the outcome.
      credentialCheck.message = `${noun} responded differently with the credential (HTTP ${credentialCheck.httpStatus}). ${credentialCheck.message}`;
    }
    checks.push(credentialCheck);

    // 3. Model listing — independent of 1 and 2, and its own capability.
    //    A gateway may legitimately have no /models route (405/404), so the raw
    //    body is inspected here rather than through the message-only diagnostic.
    let modelsSucceeded = false;
    let modelsPayload = { ok: false, message: "", status: null, category: FAILURE_CATEGORY.INVALID_RESPONSE, models: [] };
    try {
      const response = await providerFetch(target.urls.models, {
        method: "GET",
        headers,
        timeoutMs: CHECK_DEFAULTS.models.timeoutMs,
      });
      const diagnostic = await classifyUpstreamResponse(response, {
        url: target.urls.models,
        method: "GET",
        hasAuth: Boolean(apiKey),
        apiKey,
      });
      // The diagnostic carries the raw body (internal use only), so the catalog is
      // read without issuing a second request.
      const realIds = extractModelIds(diagnostic.json);
      modelsSucceeded = diagnostic.ok && realIds !== null;
      modelsPayload = {
        ok: modelsSucceeded,
        status: diagnostic.status,
        category: diagnostic.category,
        detail: diagnostic.detail,
        preview: diagnostic.preview,
        message: describeFailure(diagnostic, { noun }),
        headers: diagnostic.diagnostics,
        models: realIds || [],
      };
    } catch (error) {
      const diagnostic = networkFailureDiagnostic(error, {
        url: target.urls.models,
        method: "GET",
        hasAuth: Boolean(apiKey),
        apiKey,
      });
      modelsPayload = {
        ok: false,
        status: null,
        category: diagnostic.category,
        detail: diagnostic.detail,
        preview: "",
        message: describeFailure(diagnostic, { noun }),
        headers: {},
        models: [],
      };
    }

    const modelsCheck = {
      name: "models",
      ok: modelsPayload.ok,
      category: modelsPayload.category,
      httpStatus: modelsPayload.status,
      credentialRejected: modelsPayload.category === FAILURE_CATEGORY.INVALID_CREDENTIALS,
      message: modelsPayload.message,
      remediation: remediationFor(modelsPayload.category),
      finalUrl: target.urls.models,
      responsePreview: modelsPayload.preview,
      upstreamDetail: modelsPayload.detail,
      headers: modelsPayload.headers,
      modelCount: modelsPayload.models.length,
      models: modelsPayload.models.slice(0, 25),
    };
    // A missing catalog is a capability gap, not a broken provider: many
    // gateways serve only chat. Report it distinctly instead of failing.
    if (!modelsCheck.ok && [404, 405].includes(modelsCheck.httpStatus)) {
      modelsCheck.category = FAILURE_CATEGORY.UNSUPPORTED_OPERATION;
      modelsCheck.message = `${noun} does not expose a /models catalog (HTTP ${modelsCheck.httpStatus}). This is valid for gateways that serve chat only.`;
      modelsCheck.remediation = "No action needed if the chat check succeeds; otherwise add model IDs manually.";
    } else if (modelsCheck.ok) {
      modelsCheck.message = modelsPayload.models.length
        ? `${noun} listed ${modelsPayload.models.length} model(s).`
        : `${noun} answered but returned an empty catalog.`;
    }
    checks.push(modelsCheck);

    // 4. Chat completion — opt-in, 1 token.
    if (runChat) {
      const chatCheck = await runCheck({
        name: "chat",
        url: target.urls.chat,
        method: "POST",
        headers: jsonHeaders,
        body: chatProbeBody(modelId, apiType),
        timeoutMs: CHECK_DEFAULTS.chat.timeoutMs,
        apiKey,
        noun,
      });
      if (chatCheck.ok) {
        chatCheck.modelId = modelId;
        chatCheck.message = `${noun} completed a chat completion with "${modelId}".`;
        chatCheck.remediation = "No action needed — inference works.";
      }
      checks.push(chatCheck);
    }

    // Overall verdict: one unambiguous summary, derived rather than guessed.
    const reachable = checks.find((c) => c.name === "network")?.ok === true;
    const credentialResult = checks.find((c) => c.name === "credential");
    const credentialOk = credentialResult?.ok === true;
    const chatOk = checks.find((c) => c.name === "chat")?.ok === true;

    let verdict;
    let verdictCategory;
    if (!reachable) {
      verdict = "unreachable";
      verdictCategory = checks.find((c) => c.name === "network")?.category || FAILURE_CATEGORY.NETWORK_ERROR;
    } else if (credentialOk) {
      verdict = chatOk ? "healthy" : "usable";
      verdictCategory = FAILURE_CATEGORY.INVALID_RESPONSE;
    } else {
      // Prefer the credential check's category; fall back to the models check,
      // which is what usually explains a failure when the key was accepted.
      const credentialCategory = credentialResult?.category
        && credentialResult.category !== FAILURE_CATEGORY.INVALID_RESPONSE
        ? credentialResult.category
        : checks.find((c) => c.name === "models" && c.category !== FAILURE_CATEGORY.INVALID_RESPONSE)?.category;
      verdict = credentialCategory === FAILURE_CATEGORY.INVALID_CREDENTIALS ? "invalid_credentials" : "blocked";
      verdictCategory = credentialCategory || FAILURE_CATEGORY.NETWORK_ERROR;
    }

    // Log the outcome for operators. Credentials are never part of this record.
    console.log("[provider-diagnostics] verdict=%s category=%s host=%s checks=%d", verdict, verdictCategory, noun, checks.length);

    return res.json({
      ok: verdict === "healthy" || verdict === "usable",
      verdict,
      category: verdictCategory,
      remediation: remediationFor(verdictCategory),
      // The operator needs the base URL back without the key attached.
      target: {
        providerId,
        family: target.family,
        apiType: target.apiType,
        authScheme: target.authScheme,
        baseUrl: target.baseUrl,
        modelsUrl: target.urls.models,
        chatUrl: target.urls.chat,
        hasApiKey: Boolean(apiKey),
      },
      checks,
      // Convenience booleans so the UI can distinguish the three "good" states
      // the task asks to keep separate.
      results: { credential: credentialOk, models: checks.find((c) => c.name === "models")?.ok === true, chat: chatOk, network: reachable },
    });
  } catch (error) {
    // Never surface a parser exception or a raw stack to the client.
    const safe = redactSecrets(sanitizeUpstreamText(error?.message || "Diagnostics failed", 200));
    console.error("[provider-diagnostics] failed:", safe);
    return res.status(500).json({
      ok: false,
      verdict: "error",
      category: FAILURE_CATEGORY.INVALID_RESPONSE,
      error: "Diagnostics could not complete. See server logs.",
    });
  }
}

