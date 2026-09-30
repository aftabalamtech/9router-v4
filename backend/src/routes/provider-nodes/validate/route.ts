import { fetchWithTimeout } from "../../../lib/net/fetchWithTimeout.js";
import { buildCompatibleChatUrl, buildCompatibleModelsUrl, buildCompatibleEmbeddingsUrl, normalizeCompatibleBaseUrl, isValidCompatibleBaseUrl } from "../../../lib/net/compatibleUrl.js";
import { readResponseOnce, parseErrorPayload } from "../../../lib/net/httpBody.js";

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

function classifyUpstreamFailure(status, contentType, bodyText, diagnosticHeaders = {}) {
  const text = String(bodyText || "").trim();
  const headerText = [diagnosticHeaders?.server, diagnosticHeaders?.["cf-ray"], diagnosticHeaders?.["cf-mitigated"], diagnosticHeaders?.via]
    .filter(Boolean)
    .join(" ");
  const haystack = `${text} ${headerText}`;
  const isHtml = /text\/html|application\/xhtml\+xml/i.test(contentType || "") || /^\s*(<!doctype\s+html|<html[\s>])/i.test(text);
  if (isHtml) {
    if (/cloudflare|cf-ray|attention required|checking your browser|just a moment/i.test(haystack)) return "security_challenge";
    return "html_response";
  }
  if (status === 401) return "invalid_credentials";
  if (status === 403) return "access_denied";
  if (status === 404) return "wrong_endpoint";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_server_error";
  return "upstream_http_error";
}

async function upstreamDiagnostics(response, url, request = null) {
  const parsed = await readResponseOnce(response);
  const headers = response.headers;
  const diagnosticHeaders = {};
  for (const name of ["server", "cf-ray", "cf-mitigated", "via", "x-cache", "location", "content-type", "x-request-id"]) {
    const value = headers?.get?.(name);
    if (value) diagnosticHeaders[name] = value.slice(0, 200);
  }
  // Keep a tiny markup-free preview. Never include arbitrary HTML in a response
  // or logs; it may contain scripts, tokens, cookies, or reflected input.
  const preview = parsed.text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return {
    status: response.status,
    contentType: parsed.contentType,
    finalUrl: response.url || url,
    redirected: Boolean(response.redirected),
    // Sanitized request metadata only: method, normalized URL, auth-scheme
    // presence. Never the key, headers, or body. Lets two deployments
    // (e.g. Railway vs Render) be compared without leaking credentials.
    request,
    category: classifyUpstreamFailure(response.status, parsed.contentType, parsed.text, diagnosticHeaders),
    headers: diagnosticHeaders,
    preview,
    parsed,
  };
}

function publicDiagnostics(d) {
  return {
    contentType: d.contentType,
    finalUrl: d.finalUrl,
    redirected: d.redirected,
    request: d.request,
    headers: d.headers,
    preview: d.preview,
  };
}

function diagnosticError(d, apiKey) {
  const detail = parseErrorPayload(d.parsed.text, { status: d.status });
  if (d.category === "security_challenge") return `Upstream security challenge or access filter (HTTP ${d.status}); 9Router will not bypass it.`;
  if (d.category === "html_response") return `Upstream returned HTML instead of API JSON (HTTP ${d.status}); check base URL and upstream/proxy routing.`;
  // A non-HTML 403 whose body actually describes the key is still a credential
  // problem; a 403 with any other body (or HTML, handled above) must not be
  // reported as an invalid key.
  if (d.category === "access_denied") {
    if (/api[\s_-]?key|unauthori[sz]ed|authentication/i.test(detail)) return authFailureMessage(detail, "API key unauthorized", apiKey);
    return `Upstream denied access (HTTP ${d.status}); this does not prove the API key is invalid.`;
  }
  if (d.category === "invalid_credentials") return authFailureMessage(detail, "API key unauthorized", apiKey);
  if (d.category === "wrong_endpoint") return `Upstream endpoint not found (HTTP ${d.status}); check configured API base URL.`;
  if (d.category === "rate_limited") return `Upstream rate limited the request (HTTP ${d.status}).`;
  if (d.category === "upstream_server_error") return `Upstream server failed (HTTP ${d.status}).`;
  return `Upstream request failed (HTTP ${d.status}).`;
}

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

async function statusMessage(response) {
  const parsed = await readResponseOnce(response);
  const detail = parseErrorPayload(parsed.text, { status: parsed.status });
  return `${response.status}: ${String(detail).slice(0, 240)}`;
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
      if (embedRes.status === 401 || embedRes.status === 403) {
        return res.json({ valid: false, error: "API key unauthorized" });
      }
      const errBody = await statusMessage(embedRes);
      return res.json({
        valid: false,
        error: `Embeddings request failed (${embedRes.status})${errBody ? `: ${errBody.slice(0, 200)}` : ""}`,
        method: "embeddings"
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
            error: `Upstream ${modelsUrl} returned ${nonJsonReason} instead of a model list. Check the base URL points at the API root.`,
          });
        }
        return res.json({ valid: true });
      }

      if (isAuthFailure(modelsRes.status)) {
        return res.json({ valid: false, error: "API key unauthorized" });
      }

      // Fallback: Anthropic-compatible services usually expose /messages, not /models.
      if (modelId) {
        const messagesRes = await fetchWithTimeout(buildCompatibleChatUrl(normalizedBase, "anthropic-compatible-"), {
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
        if (isAuthFailure(messagesRes.status)) {
          return res.json({ valid: false, error: "API key unauthorized", method: "messages" });
        }
        return res.json({
          valid: false,
          status: messagesRes.status,
          error: await statusMessage(messagesRes) || getChatErrorMessage(messagesRes.status),
          method: "messages"
        });
      }

      return res.json({ valid: false, error: getModelsErrorMessage(modelsRes.status) });
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
      const { json: data, nonJsonReason } = await readResponseOnce(modelsRes);
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
        return res.json({
          valid: false,
          status: modelsRes.status,
          method: "models",
          error: `Upstream ${modelsUrl} returned ${nonJsonReason || "an unexpected body"} instead of a model list. Check the base URL points at the API root, e.g. https://host/v1.`,
        });
      }
      return res.json({ valid: true, method: "models", models });
    }

    // The `modelsRes.ok` branch above already returned, so this diagnostic is
    // always for a non-2xx response. Read the body exactly once here and reuse
    // it below — never call statusMessage()/readResponseOnce() again on it.
    const modelsRequest = { method: "GET", url: modelsUrl, auth: apiKey ? "bearer" : "none" };
    const modelsDiagnostic = await upstreamDiagnostics(modelsRes, modelsUrl, modelsRequest);

    if (isAuthFailure(modelsRes.status)) {
      return res.json({ valid: false, status: modelsDiagnostic.status, category: modelsDiagnostic.category, error: diagnosticError(modelsDiagnostic, apiKey), diagnostics: publicDiagnostics(modelsDiagnostic) });
    }

    // Some gateways reject GET /models with 405 (method not allowed) even
    // though they serve chat — treat that as "reachable, no listing".
    if (modelsRes.status === 405) {
      if (modelsDiagnostic.category === "html_response" || modelsDiagnostic.category === "security_challenge") {
        return res.json({ valid: false, status: modelsDiagnostic.status, category: modelsDiagnostic.category, error: diagnosticError(modelsDiagnostic, apiKey), diagnostics: publicDiagnostics(modelsDiagnostic) });
      }
      return res.json({ valid: true, method: "no-models", models: [], warning: "Upstream has no /models endpoint — add model IDs manually." });
    }

    if (modelsDiagnostic.category === "html_response" || modelsDiagnostic.category === "security_challenge") {
      return res.json({ valid: false, status: modelsDiagnostic.status, category: modelsDiagnostic.category, error: diagnosticError(modelsDiagnostic, apiKey), diagnostics: publicDiagnostics(modelsDiagnostic) });
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
      const chatRequest = { method: "POST", url: chatUrl, auth: apiKey ? "bearer" : "none" };
      const chatDiagnostic = await upstreamDiagnostics(chatRes, chatUrl, chatRequest);
      const chatError = diagnosticError(chatDiagnostic, apiKey);
      if (isAuthFailure(chatRes.status)) {
        return res.json({ valid: false, status: chatDiagnostic.status, category: chatDiagnostic.category, error: chatError, method: "chat", diagnostics: publicDiagnostics(chatDiagnostic) });
      }
      if (chatDiagnostic.category === "html_response" || chatDiagnostic.category === "security_challenge") {
        return res.json({ valid: false, status: chatDiagnostic.status, category: chatDiagnostic.category, error: chatError, method: "chat", diagnostics: publicDiagnostics(chatDiagnostic) });
      }
      return res.json({
        valid: false,
        status: chatRes.status,
        category: chatDiagnostic.category,
        error: chatError || getChatErrorMessage(chatRes.status),
        diagnostics: publicDiagnostics(chatDiagnostic),
        method: apiType === "responses" ? "responses" : "chat"
      });
    }

    // No chat fallback (no modelId): report the /models outcome with its
    // category and sanitized upstream diagnostics instead of a bare message.
    return res.json({
      valid: false,
      status: modelsDiagnostic.status,
      category: modelsDiagnostic.category,
      error: diagnosticError(modelsDiagnostic, apiKey),
      diagnostics: publicDiagnostics(modelsDiagnostic),
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
