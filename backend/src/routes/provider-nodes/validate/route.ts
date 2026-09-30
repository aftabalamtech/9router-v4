import { fetchWithTimeout } from "../../../lib/net/fetchWithTimeout.js";
import { buildCompatibleChatUrl, buildCompatibleModelsUrl, buildCompatibleEmbeddingsUrl, normalizeCompatibleBaseUrl, isValidCompatibleBaseUrl } from "../../../lib/net/compatibleUrl.js";
import { readJsonBody, readResponseOnce, parseErrorPayload } from "../../../lib/net/httpBody.js";

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
  if (status >= 500) return "Server error - try again later";
  return `Unexpected response (${status})`;
};

// Get status-specific error message for /chat/completions endpoint
const getChatErrorMessage = (status) => {
  if (status === 401 || status === 403) return "API key unauthorized";
  if (status === 400) return "Invalid model or bad request";
  if (status === 404) return "Chat endpoint not found";
  if (status >= 500) return "Server error - try again later";
  return `Chat request failed (${status})`;
};

const isAuthFailure = (status) => status === 401 || status === 403;

const trimBaseUrl = normalizeCompatibleBaseUrl;

function authHeaders(apiKey, extra = {}) {
  const headers = { ...extra };
  const authKey = Object.keys(headers).find((key) => key.toLowerCase() === "authorization");
  if (authKey) {
    const value = String(headers[authKey]);
    if (/^bearer\s*$/i.test(value) && apiKey) headers[authKey] = `Bearer ${apiKey}`;
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

async function statusMessage(response) {
  const parsed = await readResponseOnce(response);
  const detail = parseErrorPayload(parsed.text, { status: parsed.status });
  return `${response.status}: ${String(detail).slice(0, 240)}`;
}

// POST /api/provider-nodes/validate - Validate API key against base URL
// API key is OPTIONAL: self-hosted gateways (LM Studio, Ollama OpenAI shim,
// LiteLLM, vLLM…) frequently run unauthenticated. An empty key must validate
// against /models instead of being rejected up front.
export async function POST_handler(req, res) {
  try {
    const body = req.body;
    const { baseUrl, apiKey, type, modelId, apiType = "chat", headers: customHeaders = {} } = body;

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
        const { json: data } = await readJsonBody(embedRes);
        const dims = Array.isArray(data?.data?.[0]?.embedding) ? data.data[0].embedding.length : null;
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
      const res = await fetchWithTimeout(modelsUrl, {
        method: "GET",
        headers: {
          ...(apiKey ? { "x-api-key": apiKey } : {}),
          ...customHeaders,
          "anthropic-version": "2023-06-01",
        }
      });

      if (res.ok) return res.json({ valid: true });

      if (isAuthFailure(res.status)) {
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

      return res.json({ valid: false, error: getModelsErrorMessage(res.status) });
    }

    // OpenAI Compatible Validation (Default)
    const normalizedBase = trimBaseUrl(baseUrl);
    const modelsUrl = buildCompatibleModelsUrl(normalizedBase);
    const requestHeaders: Record<string, string> = authHeaders(apiKey, customHeaders);
    const res = await fetchWithTimeout(modelsUrl, { headers: requestHeaders });

    if (res.ok) {
      // Surface the discovered model list so the caller can offer one-click
      // import right after a successful Test Connection.
      let models: Array<{ id: string; name?: string }> = [];
      try {
        const { json: data } = await readJsonBody(res);
        const raw = Array.isArray(data) ? data : (data?.data || data?.models || data?.results || []);
        if (Array.isArray(raw)) {
          models = raw
            .map((m: { id?: unknown; name?: unknown; model?: unknown }) => {
              const id = typeof m === "string" ? m : (m?.id || m?.model || "");
              if (!id || typeof id !== "string") return null;
              const name = typeof m === "object" && m && typeof (m as { name?: unknown }).name === "string" ? (m as { name: string }).name : id;
              return { id, name };
            })
            .filter(Boolean)
            .slice(0, 500);
        }
      } catch { /* body wasn't JSON — validation still succeeded */ }
      return res.json({ valid: true, method: "models", models });
    }

    if (isAuthFailure(res.status)) {
      return res.json({ valid: false, error: "API key unauthorized" });
    }

    // Some gateways reject GET /models with 405 (method not allowed) even
    // though they serve chat — treat that as "reachable, no listing".
    if (res.status === 405) {
      return res.json({ valid: true, method: "no-models", models: [], warning: "Upstream has no /models endpoint — add model IDs manually." });
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
        const { json } = await readJsonBody(chatRes);
        if (apiType === "responses" ? Boolean(json && ("output" in json || "id" in json)) : Boolean(json && ("choices" in json || "id" in json))) {
          return res.json({ valid: true, status: chatRes.status, method: apiType === "responses" ? "responses" : "chat" });
        }
        return res.json({ valid: false, status: chatRes.status, method: apiType === "responses" ? "responses" : "chat", error: "HTTP success, but response did not match expected OpenAI-compatible format." });
      }
      const chatError = await statusMessage(chatRes);
      if (isAuthFailure(chatRes.status)) {
        return res.json({ valid: false, error: "API key unauthorized", method: "chat" });
      }
      return res.json({
        valid: false,
        status: chatRes.status,
        error: chatError || getChatErrorMessage(chatRes.status),
        method: apiType === "responses" ? "responses" : "chat"
      });
    }

    return res.json({ valid: false, error: getModelsErrorMessage(res.status) });
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
      error: errorMessage
    });
  }
}
