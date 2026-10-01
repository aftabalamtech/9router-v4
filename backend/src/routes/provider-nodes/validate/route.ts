import { fetchWithTimeout } from "../../../lib/net/fetchWithTimeout.js";
import { buildCompatibleChatUrl, buildCompatibleModelsUrl, buildCompatibleEmbeddingsUrl, normalizeCompatibleBaseUrl, isValidCompatibleBaseUrl } from "../../../lib/net/compatibleUrl.js";
import { readResponseOnce, parseErrorPayload } from "../../../lib/net/httpBody.js";
import { readUpstreamDiagnostic, publicUpstreamDiagnostics, describeUpstreamFailure, sanitizeUpstreamText } from "../../../lib/net/upstreamDiagnostics.js";

// Validate URL format
const isValidUrl = isValidCompatibleBaseUrl;

// Parse error details for user-friendly messages
const getErrorMessage = (error) => {
  if (error.cause?.code === "ECONNREFUSED") return "Connection refused - provider node offline or unreachable";
  if (error.cause?.code === "ENOTFOUND") return "DNS lookup failed - invalid domain or network issue";
  if (error.cause?.code === "ETIMEDOUT") return "Connection timeout - provider node too slow";
  if (error.message.includes("timeout")) return "Request timeout (>10s) - provider node not responding";
  if (error.cause?.code === "CERT_HAS_EXPIRED") return "SSL certificate expired";
  if (error.cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "SSL certificate verification failed";
  if (error.cause?.code) return `Network error: ${error.cause.code}`;
  return "Network connection failed - check URL and network connectivity";
};

// Get status-specific error message for /models endpoint
const getModelsErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 404) return "/models endpoint not found - try chat validation with model ID";
  if (status === 405) return "/models endpoint does not allow this method";
  if (status === 429) return "Rate limited by upstream (HTTP 429) - retry later or check quota";
  if (status >= 500) return "Upstream server error - try again later";
  return `Unexpected response (${status})`;
};

// Get status-specific error message for /chat/completions endpoint
const getChatErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 400) return "Invalid model or bad request";
  if (status === 404) return "Chat endpoint not found";
  if (status === 429) return "Rate limited by upstream (HTTP 429) - retry later or check quota";
  if (status >= 500) return "Upstream server error - try again later";
  return `Chat request failed (${status})`;
};

const isAuthFailure = (status) => status === 401 || status === 403;

// Classification, redaction and message wording now live in
// lib/net/upstreamDiagnostics.js, shared with /api/providers/validate and the
// saved-connection test in providers/[id]/test. Those two used to return the
// bare string "Invalid API key" for any 401/403, which is how a Cloudflare
// challenge page ended up labelled as a credential failure.

const trimBaseUrl = normalizeCompatibleBaseUrl;

function authHeaders(apiKey, extra = {}) {
  const headers = { ...extra };
  // Defensive trim: HTTP drops trailing whitespace in header values, so this
  // is hygiene for keys pasted with stray whitespace, not an auth fix.
  const key = typeof apiKey === "string" ? apiKey.trim() : apiKey;
  const authKey = Object.keys(headers).find((k) => k.toLowerCase() === "authorization");
  if (authKey) {
    const value = String(headers[authKey]);
    if (/^bearer\s*$/i.test(value) && key) headers[authKey] = `Bearer ${key}`;
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

// Retained for callers that only want a short upstream detail line. Strips
// markup and redacts credentials, so an HTML error page can never be relayed
// into a user-visible string. Prefer readUpstreamDiagnostic() for new code.
async function statusMessage(response) {
  const parsed = await readResponseOnce(response);
  const detail = sanitizeUpstreamText(parseErrorPayload(parsed.text, { status: parsed.status }), 240);
  return `${response.status}: ${detail}`;
}

/**
 * Auth-failure message that keeps the upstream reason ("Missing API key" vs
 * "Invalid or revoked API key") so the user can tell a rejected key from a key
 * that never reached the provider. The key itself is never included: an
 * upstream that echoes the credential back must not relay it to the browser.
 */
function authFailureMessage(detail, fallback = "API key unauthorized", apiKey = "") {
  let reason = String(detail || "").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (key.length >= 8) reason = reason.split(key).join("[redacted]");
  reason = reason.trim();
  return reason ? `${fallback} - upstream said: ${reason}` : fallback;
}

// POST /api/provider-nodes/validate - Validate API key against base URL
// API key is OPTIONAL: self-hosted gateways (LM Studio, Ollama OpenAI shim,
// LiteLLM, vLLM…) frequently run unauthenticated. An empty key must validate
// against /models instead of being rejected up front.
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const { baseUrl, type, modelId, apiType = "chat", headers: customHeaders = {} } = body;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : body.apiKey;

    if (!baseUrl) {
      return res.status(400).json({ error: "Base URL is required" });
    }

    // Validate URL format
    if (!isValidUrl(baseUrl)) {
      return res.status(400).json({ error: "Invalid URL format" });
    }

    // Custom Embedding Validation - test POST /embeddings directly
    if (type === "custom-embedding") {
      const normalizedBase = trimBaseUrl(baseUrl);
      if (!modelId?.trim()) {
        return res.json({ valid: false, error: "Model ID required for embedding validation" });
      }
      const embedRes = await fetchWithTimeout(buildCompatibleEmbeddingsUrl(normalizedBase), {
        method: "POST",
        headers: {
          ...authHeaders(apiKey, customHeaders),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: modelId.trim(), input: "ping" })
      });
      if (embedRes.ok) {
        const { json: data, nonJsonReason } = await readResponseOnce(embedRes);
        const dims = Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding.length : null;
        // 2xx without an embedding vector is not a usable embeddings endpoint
        // (typically an HTML page from a wrong base URL).
        if (dims === null && data === null) {
          return res.json({
            valid: false,
            method: "embeddings",
            error: `Embeddings endpoint returned ${nonJsonReason || "an unexpected body"} (HTTP ${embedRes.status}). Check the base URL points at the API root.`,
          });
        }
        return res.json({ valid: true, method: "embeddings", dimensions: dims });
      }
      const embedDiagnostic = await readUpstreamDiagnostic(embedRes, {
        url: buildCompatibleEmbeddingsUrl(normalizedBase),
        method: "POST",
        hasAuth: !!apiKey,
        apiKey,
      });
      return res.json({
        valid: false,
        method: "embeddings",
        status: embedDiagnostic.status,
        category: embedDiagnostic.category,
        error: describeUpstreamFailure(embedDiagnostic, { apiKey, noun: "Upstream embeddings endpoint" }),
        diagnostics: publicUpstreamDiagnostics(embedDiagnostic),
      });
    }

    // Anthropic Compatible Validation
    if (type === "anthropic-compatible") {
      const normalizedBase = trimBaseUrl(baseUrl);

      const modelsUrl = buildCompatibleModelsUrl(normalizedBase, "anthropic-compatible-");
      // Never name an upstream response `res`: it would shadow the Express
      // response and every `res.json(...)` below would write to the UPSTREAM
      // stream instead of replying to the client.
      const modelsRes = await fetchWithTimeout(modelsUrl, {
        method: "GET",
        headers: {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...customHeaders,
          "anthropic-version": "2023-06-01",
        }
      });

      if (modelsRes.ok) {
        const { json, nonJsonReason } = await readResponseOnce(modelsRes);
        if (json === null) {
          return res.json({
            valid: false,
            status: modelsRes.status,
            category: "html_response",
            error: `Upstream ${modelsUrl} returned ${nonJsonReason} instead of a model list. Check the base URL points at the API root.`,
          });
        }
        return res.json({ valid: true });
      }

      const anthModelsDiagnostic = await readUpstreamDiagnostic(modelsRes, { url: modelsUrl, method: "GET", hasAuth: !!apiKey, apiKey });

      // Fallback: Anthropic-compatible services usually expose /messages, not /models.
      if (modelId && !anthModelsDiagnostic.nonJsonBody) {
        const messagesUrl = buildCompatibleChatUrl(normalizedBase, "anthropic-compatible-");
        const messagesRes = await fetchWithTimeout(messagesUrl, {
          method: "POST",
          headers: {
            ...(apiKey ? { "x-api-key": apiKey } : {}),
            ...customHeaders,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          })
        });
        if (messagesRes.ok) return res.json({ valid: true, method: "messages" });
        const messagesDiagnostic = await readUpstreamDiagnostic(messagesRes, {
          url: messagesUrl,
          method: "POST",
          hasAuth: !!apiKey,
          apiKey,
        });
        return res.json({
          valid: false,
          method: "messages",
          status: messagesDiagnostic.status,
          category: messagesDiagnostic.category,
          error: describeUpstreamFailure(messagesDiagnostic, { apiKey, noun: "Upstream messages endpoint" }),
          diagnostics: publicUpstreamDiagnostics(messagesDiagnostic),
        });
      }

      return res.json({
        valid: false,
        method: "models",
        status: anthModelsDiagnostic.status,
        category: anthModelsDiagnostic.category,
        error: describeUpstreamFailure(anthModelsDiagnostic, { apiKey, noun: "Upstream /models" }),
        diagnostics: publicUpstreamDiagnostics(anthModelsDiagnostic),
      });
    }

    // OpenAI Compatible Validation (Default)
    const normalizedBase = trimBaseUrl(baseUrl);
    const modelsUrl = buildCompatibleModelsUrl(normalizedBase);
    const requestHeaders: Record<string, string> = authHeaders(apiKey, customHeaders);
    // See the Anthropic branch above: naming this `res` silently replied to the
    // upstream stream instead of the client.
    const modelsRes = await fetchWithTimeout(modelsUrl, { headers: requestHeaders });

    if (modelsRes.ok) {
      // Surface the discovered model list so the caller can offer one-click
      // import right after a successful Test Connection.
      let models: Array<{ id: string; name?: string }> = [];
      const { json: data, text: modelsText, nonJsonReason } = await readResponseOnce(modelsRes);
      const nonJsonPreview = sanitizeUpstreamText(modelsText);
      // Do NOT default a missing list field to []: an HTML/empty/text body
      // parses to `null`, and defaulting would make it indistinguishable from a
      // real, legitimately empty model list.
      const listCandidate = Array.isArray(data) ? data : (data?.data ?? data?.models ?? data?.results);
      const isModelList = Array.isArray(listCandidate);
      if (isModelList) {
        models = listCandidate
          .map((m: { id?: unknown; name?: unknown; model?: unknown }) => {
            const id = typeof m === "string" ? m : (m?.id || m?.model || "");
            if (!id || typeof id !== "string") return null;
            const name = typeof m === "object" && m && typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name : id;
            return { id, name };
          })
          .filter(Boolean)
          .slice(0, 500);
      }
      // A 2xx that is not a model list is NOT a valid connection. Reporting it
      // as valid is what hid an HTML marketing/proxy page behind a green
      // "Valid" badge, and is what produced the raw `Unexpected token '<'`
      // parser error once a parse was attempted.
      if (!isModelList) {
        // A 2xx whose body is not a model list — typically the provider's own
        // marketing page, served when the base URL lacks /v1. The body was
        // already read above, so classify from that instead of re-reading.
        const ct = modelsRes.headers?.get?.("content-type") || "";
        const looksHtml = /text\/html|application\/xhtml\+xml/i.test(ct);
        const challenge = looksHtml && /cloudflare|cf-ray|attention required|just a moment|ie6 oldie/i.test(nonJsonPreview || "");
        return res.json({
          valid: false,
          method: "models",
          status: modelsRes.status,
          category: challenge ? "security_challenge" : looksHtml ? "html_response" : "malformed_response",
          error: `Upstream ${modelsUrl} returned ${nonJsonReason || "an unexpected body"} instead of a model list. Check the base URL points at the API root, e.g. https://host/v1.`,
        });
      }
      return res.json({ valid: true, method: "models", models });
    }

    // The `modelsRes.ok` branch above already returned, so this diagnostic is
    // always for a non-2xx response. Read the body exactly once here and reuse
    // it below — never call statusMessage()/readResponseOnce() again on it.
    const modelsDiagnostic = await readUpstreamDiagnostic(modelsRes, { url: modelsUrl, method: "GET", hasAuth: !!apiKey, apiKey });
    const modelsPublic = publicUpstreamDiagnostics(modelsDiagnostic);

    // A JSON 404/405 means this gateway has no catalog here (many
    // OpenAI-compatible services don't) — the chat endpoint is the real test.
    // An HTML body behind those statuses is NOT "no listing": it is the wrong
    // endpoint or a challenge page, and must fail with its real category.
    const catalogMissing = [404, 405].includes(modelsRes.status) && !modelsDiagnostic.looksHtml;
    if (!catalogMissing) {
      return res.json({
        valid: false,
        method: "models",
        status: modelsDiagnostic.status,
        category: modelsDiagnostic.category,
        error: describeUpstreamFailure(modelsDiagnostic, { apiKey, noun: "Upstream /models" }),
        diagnostics: modelsPublic,
      });
    }

    // Fallback: try chat/completions if modelId provided
    if (modelId) {
      const chatUrl = buildCompatibleChatUrl(normalizedBase, `openai-compatible-${apiType === "responses" ? "responses" : "chat"}-`);
      const chatRes = await fetchWithTimeout(chatUrl, {
        method: "POST",
        headers: {
          ...authHeaders(apiKey, customHeaders),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: modelId,
          ...(apiType === "responses"
            ? { input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }], max_output_tokens: 1 }
            : { messages: [{ role: "user", content: "ping" }], max_tokens: 1 })
        })
      });
      if (chatRes.ok) {
        const { json, nonJsonReason } = await readResponseOnce(chatRes);
        if (apiType === "responses" ? Boolean(json && ("output" in json || "id" in json)) : Boolean(json && ("choices" in json || "id" in json))) {
          return res.json({ valid: true, status: chatRes.status, method: apiType === "responses" ? "responses" : "chat" });
        }
        return res.json({
          valid: false,
          status: chatRes.status,
          method: apiType === "responses" ? "responses" : "chat",
          error: `Upstream returned ${nonJsonReason || "a body that is not an OpenAI-compatible response"} (HTTP ${chatRes.status}). Check the base URL and API type.`,
        });
      }
      const chatDiagnostic = await readUpstreamDiagnostic(chatRes, { url: chatUrl, method: "POST", hasAuth: !!apiKey, apiKey });
      return res.json({
        valid: false,
        method: apiType === "responses" ? "responses" : "chat",
        status: chatDiagnostic.status,
        category: chatDiagnostic.category,
        error: describeUpstreamFailure(chatDiagnostic, { apiKey, noun: "Upstream chat endpoint" }),
        diagnostics: publicUpstreamDiagnostics(chatDiagnostic),
      });
    }

    // Unreachable: the non-2xx return above always fires first. Kept as a
    // defensive fallback so no path can return a bare message again.
    return res.json({
      valid: false,
      status: modelsDiagnostic.status,
      category: modelsDiagnostic.category,
      error: describeUpstreamFailure(modelsDiagnostic, { apiKey, noun: "Upstream /models" }),
      diagnostics: modelsPublic,
    });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    console.error("Error validating provider node:", {
      message: error.message,
      cause: error.cause,
      code: error.cause?.code,
      userMessage: errorMessage
    });
    return res.status(500).json({
      valid: false,
      error: errorMessage,
      // Category only. The raw exception (e.g. a JSON parser message) is
      // logged, never returned, so the UI cannot show a parser error.
      category: "internal_error",
    });
  }
}
