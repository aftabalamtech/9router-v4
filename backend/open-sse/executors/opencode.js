import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { injectReasoningContent } from "../utils/reasoningContentInjector.js";
import { openaiToOpenAIResponsesRequest } from "../translator/request/openai-responses.js";
import { openaiResponsesToOpenAIResponse } from "../translator/response/openai-responses.js";
import { initState } from "../translator/index.js";
import { parseSSELine, formatSSE } from "../utils/streamHelpers.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

const ZEN_BASE = "https://opencode.ai/zen/v1";

// Placeholder token used for anonymous requests (virtual "Public" connection).
// NOTE (2026-09-20): OpenCode now rejects anonymous free-tier use server-side
// ("FreeTierError: OpenCode's free tier can only be used from within OpenCode").
// A free API key from https://opencode.ai/auth unlocks the $0 free models.
const ANON_TOKEN = "public";

// Models served by /zen/v1/responses (OpenAI Responses API), NOT /chat/completions.
// Verified 2026-09-20: /chat/completions returns "Internal server error" for these
// while /responses routes them to the provider (FreeTierError when anonymous).
const RESPONSES_MODELS = new Set([
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
]);

// Models that use /zen/v1/messages (claude format)
const MESSAGES_MODELS = new Set();

// Models that cannot be served through the chat flow at all.
const UNSUPPORTED_MODELS = new Map([
  [
    "jev-1.13-free",
    "jev-1.13-free is a SystemOne decision model served only at " +
    "https://opencode.ai/zen/v1/systemone — it cannot answer chat requests. " +
    "Remove it from this provider's chat models.",
  ],
]);

function stripAlias(model) {
  return String(model || "").replace(/^oc\//, "");
}

function extractResponsesText(data) {
  if (!data || typeof data !== "object") return "";
  const out = Array.isArray(data.output) ? data.output : [];
  const parts = [];
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) {
        if ((c?.type === "output_text" || c?.type === "text") && typeof c.text === "string") {
          parts.push(c.text);
        }
      }
    }
  }
  return parts.join("");
}

function responsesObjectToChatCompletion(data, model) {
  const text = extractResponsesText(data);
  const usage = data?.usage && typeof data.usage === "object" ? {
    prompt_tokens: data.usage.input_tokens ?? 0,
    completion_tokens: data.usage.output_tokens ?? 0,
    total_tokens: data.usage.total_tokens ?? ((data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0)),
  } : undefined;
  return {
    id: data?.id ? `chatcmpl-${data.id}` : `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    ...(usage ? { usage } : {}),
  };
}

export class OpenCodeExecutor extends BaseExecutor {
  constructor() {
    super("opencode", PROVIDERS.opencode);
  }

  isResponsesModel(model) {
    return RESPONSES_MODELS.has(stripAlias(model));
  }

  transformRequest(model, body, stream, credentials) {
    const withReasoning = injectReasoningContent({ provider: this.provider, model, body });
    if (this.isResponsesModel(model)) {
      const translated = openaiToOpenAIResponsesRequest(
        stripAlias(withReasoning.model || model),
        withReasoning,
        stream,
        credentials
      );
      // The translator forces stream:true — honor the actual request mode so
      // non-streaming callers (health checks) get a single JSON object back.
      translated.stream = stream !== false;
      return translated;
    }
    return withReasoning;
  }

  buildUrl(model) {
    const id = stripAlias(model);
    if (RESPONSES_MODELS.has(id)) return `${ZEN_BASE}/responses`;
    if (MESSAGES_MODELS.has(id)) return `${ZEN_BASE}/messages`;
    return `${ZEN_BASE}/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const key = credentials?.apiKey || credentials?.accessToken;
    const token = key && key !== ANON_TOKEN ? key : ANON_TOKEN;
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${token}`,
      // Identify as the official client (matches opencode v2 headers)
      "x-opencode-client": "opencode",
      "X-Title": "opencode",
      "HTTP-Referer": "https://opencode.ai/",
      "Accept": stream ? "text/event-stream" : "application/json",
    };
  }

  async execute(options) {
    const { model, log } = options;
    const id = stripAlias(model);

    if (UNSUPPORTED_MODELS.has(id)) {
      const message = UNSUPPORTED_MODELS.get(id);
      log?.warn?.("OPENCODE", message);
      return {
        response: new Response(
          JSON.stringify({ error: { type: "unsupported_model", message } }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        ),
        url: this.buildUrl(model),
        headers: {},
        transformedBody: options.body,
      };
    }

    if (!this.isResponsesModel(model)) {
      return super.execute(options);
    }
    return this.executeWithResponsesEndpoint(options);
  }

  async executeWithResponsesEndpoint({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    const upstreamId = stripAlias(body?.model || model);
    const url = this.buildUrl(model);
    const headers = this.buildHeaders(credentials, stream);
    const transformedBody = this.transformRequest(model, body, stream, credentials);

    log?.debug?.("OPENCODE", `Sending translated request to /responses for ${upstreamId}`);

    const response = await proxyAwareFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(transformedBody),
      signal,
    }, proxyOptions);

    if (!response.ok) {
      return { response, url, headers, transformedBody };
    }

    // Non-streaming: upstream returns a single Response JSON object —
    // convert it to a chat.completion JSON object for the downstream handlers.
    if (stream === false) {
      const data = await response.json().catch(() => null);
      if (!data || data.error) {
        return {
          response: new Response(JSON.stringify(data || { error: "Empty responses payload" }), {
            status: data ? response.status : 502,
            headers: { "Content-Type": "application/json" },
          }),
          url,
          headers,
          transformedBody,
        };
      }
      return {
        response: new Response(JSON.stringify(responsesObjectToChatCompletion(data, upstreamId)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
        url,
        headers,
        transformedBody,
      };
    }

    // Streaming: convert Responses SSE events to chat.completion.chunk SSE.
    const state = initState("openai-responses");
    state.model = upstreamId;

    const decoder = new TextDecoder();
    let buffer = "";

    const transformStream = new TransformStream({
      async transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const parsed = parseSSELine(trimmed);
          if (!parsed) continue;

          if (parsed.done && stream === true) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            continue;
          }

          const converted = openaiResponsesToOpenAIResponse(parsed, state);
          if (converted) {
            const sseString = formatSSE(converted, "openai");
            controller.enqueue(new TextEncoder().encode(sseString));
          }
        }
      },
      flush(controller) {
        if (buffer.trim()) {
          const parsed = parseSSELine(buffer.trim());
          if (parsed && !parsed.done) {
            const converted = openaiResponsesToOpenAIResponse(parsed, state);
            if (converted) {
              controller.enqueue(new TextEncoder().encode(formatSSE(converted, "openai")));
            }
          }
        }
      },
    });

    if (!response.body) {
      return {
        response: new Response("", { status: response.status, headers: response.headers }),
        url,
        headers,
        transformedBody,
      };
    }
    const convertedStream = response.body.pipeThrough(transformStream);

    return {
      response: new Response(convertedStream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      url,
      headers,
      transformedBody,
    };
  }
}
