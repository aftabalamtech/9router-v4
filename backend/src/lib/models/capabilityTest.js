// Capability-specific model test adapters.
//
// Replaces the if/else chain in routes/models/test/ping.js, which had branches
// for embedding/image/stt and silently fell through to CHAT for everything
// else — so an image model tested as "audio" was probed with a chat request and
// that failure looked like a broken model. `vision`, `rerank` and `custom` did
// not exist at all.
//
// STRUCTURE
//   validateCapabilityResponse()  PURE: response body -> { ok, error, code }
//   buildTestRequest()            PURE: capability + settings -> request shape
//   runCapabilityTest()          I/O: one request, parse, classify
//
// The pure half carries the interesting logic (what counts as a valid image /
// vector / ranking, and how an upstream error is classified) and is unit-tested
// directly with no network, so the edge cases are cheap to cover.

import { readResponseOnce, parseErrorPayload } from "../../lib/net/httpBody.js";
import { getApiKeys } from "../../lib/localDb.js";
import { getConsistentMachineId } from "../../shared/utils/machineId.js";
import {
  getCapabilitySpec,
  normalizeCapability,
  TEST_STATUS,
} from "../../shared/constants/modelCapabilities.js";

const CLI_TOKEN_SALT = "9r-cli-auth";

/**
 * Error codes. `classifyTestError` in testBatch.js owns the shared vocabulary;
 * these are the values that classify into, extended here with the two cases
 * that capability testing adds and the old code had no way to express:
 *   unsupported — the provider/operation does not offer this capability. This
 *                 is NOT a failure and must never be reported as one.
 *   invalid_request — the test request itself was wrong (e.g. no audio file
 *                 configured for a speech-to-text test).
 */
export const ERROR_CODES = Object.freeze({
  TIMEOUT: "timeout",
  AUTH: "auth",
  RATE_LIMITED: "rate_limited",
  NOT_FOUND: "not_found",
  UNSUPPORTED: "unsupported",
  INVALID_REQUEST: "invalid_request",
  MALFORMED: "malformed",
  NETWORK: "network",
  PROVIDER: "provider",
  UNKNOWN: "unknown",
});

// Patterns that mean "this endpoint/operation does not exist here". Checked
// before the generic 4xx branch so an unsupported capability is never
// misreported as a provider error (and therefore never shown as a red failure).
const UNSUPPORTED_PATTERNS = [
  "not implemented",
  "not supported",
  "unsupported",
  // The gateway's own wording when a provider does not offer the operation,
  // e.g. "Provider 'opencode' does not support embeddings." Without these the
  // operation would be recorded as a generic provider error, i.e. a red
  // failure for something the provider simply never offered.
  "does not support",
  "do not support",
  "no such endpoint",
  "unknown endpoint",
  "unknown route",
  "no route",
  "404 page not found",
  "is not a valid model",
  "unsupported operation",
  "unsupported capability",
];

const INVALID_MODEL_PATTERNS = [
  "model_not_found",
  "does not exist",
  "no such model",
  "unknown model",
  "invalid model",
  "model not found",
  "is not a valid model",
  "unknown model id",
];

const RATE_PATTERNS = ["rate limit", "too many requests", "quota", "rate_limit", "429"];
const AUTH_PATTERNS = ["unauthorized", "invalid api key", "authentication", "forbidden", "invalid_api_key", "permission denied"];
const TIMEOUT_PATTERNS = ["timeout", "timed out", "aborted", "etimedout", "deadline exceeded"];

/**
 * Classify an upstream failure into a code. Pure.
 *
 * Order matters: an unsupported endpoint frequently arrives as a 404, so the
 * "unsupported" patterns are tested before the generic not_found branch, and
 * rate-limit/auth patterns are checked against the MESSAGE as well as the
 * status because providers disagree about which they use.
 */
export function classifyCapabilityError({ status, message, body } = {}) {
  const text = `${message || ""} ${typeof body === "string" ? body : ""}`.toLowerCase();

  if (TIMEOUT_PATTERNS.some((p) => text.includes(p))) return ERROR_CODES.TIMEOUT;
  if (UNSUPPORTED_PATTERNS.some((p) => text.includes(p))) return ERROR_CODES.UNSUPPORTED;
  if (AUTH_PATTERNS.some((p) => text.includes(p)) || status === 401 || status === 403) {
    return ERROR_CODES.AUTH;
  }
  if (RATE_PATTERNS.some((p) => text.includes(p)) || status === 429) return ERROR_CODES.RATE_LIMITED;
  if (INVALID_MODEL_PATTERNS.some((p) => text.includes(p)) || status === 404) {
    return ERROR_CODES.NOT_FOUND;
  }
  if (["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EAI_AGAIN"].includes(message)) {
    return ERROR_CODES.NETWORK;
  }
  if (/econnrefused|enotfound|fetch failed|socket|econnreset|network error/i.test(text)) {
    return ERROR_CODES.NETWORK;
  }
  if (status && status >= 400) return ERROR_CODES.PROVIDER;
  return ERROR_CODES.UNKNOWN;
}

// ── Response validators ───────────────────────────────────────────
// One per validation token in the capability spec. Each returns null when the
// response is valid, or a human-readable reason when it is not. Returning a
// REASON (not a boolean) is deliberate: "Provider returned an empty
// embeddings array" tells the user what actually went wrong, where "invalid
// response" does not.

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * A vector must be a non-empty array of finite numbers. A response with
 * `embedding: []` or `embedding: ["a"]` is malformed, not a pass.
 */
function isValidVector(v) {
  return Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

const VALIDATORS = {
  choices(body) {
    if (!body || typeof body !== "object") return "Provider returned a non-object response";
    // Some gateways wrap the payload in `data`.
    const choices = Array.isArray(body.choices)
      ? body.choices
      : Array.isArray(body.data?.choices)
        ? body.data.choices
        : null;
    if (!choices) return "Provider returned no completion choices for this model";
    if (choices.length === 0) return "Provider returned an empty choices array";
    // An empty (or absent) message with no tool calls means nothing came back.
    // A tool call IS a valid response, so it must not be rejected.
    const first = choices[0] || {};
    const hasText = isNonEmptyString(first.message?.content)
      || isNonEmptyString(first.text)
      || isNonEmptyString(first.delta?.content);
    const hasToolCall = (first.message?.tool_calls || first.tool_calls)?.length > 0;
    const hasReasoning = isNonEmptyString(first.message?.reasoning_content);
    if (!hasText && !hasToolCall && !hasReasoning) {
      return "Provider returned a completion with no content";
    }
    return null;
  },
  data(body) {
    if (!body || typeof body !== "object") return "Provider returned a non-object response";
    const data = Array.isArray(body.data) ? body.data : null;
    if (!data) return "Provider returned no image data for this model";
    if (data.length === 0) return "Provider returned an empty image data array";
    // Accept a URL, a b64 payload, or a direct reference — providers differ,
    // but an entry with NONE of them is not a usable image.
    const first = data[0] || {};
    const hasImage = isNonEmptyString(first.url)
      || isNonEmptyString(first.b64_json)
      || isNonEmptyString(first.image_url)
      || isNonEmptyString(first.revised_prompt);
    if (!hasImage) return "Provider returned an image entry with no url or image data";
    return null;
  },
  vector(body) {
    if (!body || typeof body !== "object") return "Provider returned a non-object response";
    const data = Array.isArray(body.data) ? body.data : null;
    if (!data) return "Provider returned no embedding data";
    if (data.length === 0) return "Provider returned an empty embedding data array";
    if (!isValidVector(data[0]?.embedding)) {
      return "Provider returned an embedding that is not a non-empty numeric vector";
    }
    return null;
  },
  text(body) {
    if (!body || typeof body !== "object") return "Provider returned a non-object response";
    if (!isNonEmptyString(body.text)) {
      return "Provider returned no transcription text for this model";
    }
    return null;
  },
  audio(body, rawText) {
    // TTS returns audio bytes. The JSON path is accepted for gateways that
    // wrap the result, but a base payload that is not audio is a failure.
    if (body && typeof body === "object" && (isNonEmptyString(body.audio) || isNonEmptyString(body.url))) {
      return null;
    }
    if (rawText && rawText.length > 32) return null;
    return "Provider returned no audio data for this model";
  },
  jobRef(body) {
    if (!body || typeof body !== "object") return "Provider returned a non-object response";
    // Asynchronous video APIs return a job/reference in one of several shapes.
    const ref = body.id || body.job_id || body.jobId || body.task_id || body.request_id
      || body.data?.id || body.output?.job_id;
    if (!isNonEmptyString(ref) && typeof ref !== "number") {
      return "Provider returned no video job reference";
    }
    return null;
  },
  rankedResults(body) {
    if (!body || typeof body !== "object") return "Provider returned a non-object response";
    // Cohere uses `results`, Jina-style uses `data`, some use `rankings`.
    const results = Array.isArray(body.results)
      ? body.results
      : Array.isArray(body.data)
        ? body.data
        : Array.isArray(body.rankings)
          ? body.rankings
          : null;
    if (!results) return "Provider returned no ranking results";
    if (results.length === 0) return "Provider returned an empty ranking list";
    const first = results[0] || {};
    // A ranked result must identify a document; the score is optional because
    // some providers return relevance scores only when asked.
    const hasDoc = first.document !== undefined
      || first.index !== undefined
      || first.id !== undefined
      || first.text !== undefined;
    if (!hasDoc) return "Provider returned a ranking result with no document reference";
    if (first.relevance_score !== undefined && typeof first.relevance_score !== "number") {
      return "Provider returned a non-numeric relevance score";
    }
    return null;
  },
  ok() {
    // `custom` is validated by the caller's own rules; the adapter only
    // confirms a non-error HTTP response.
    return null;
  },
};

/**
 * Validate an upstream response body for one capability. Pure.
 *
 * @returns {{ ok: boolean, error: string|null, code: string|null }}
 */
export function validateCapabilityResponse({ capability, body, rawText = "", status }) {
  const id = normalizeCapability(capability);
  if (!id) {
    return {
      ok: false,
      error: `Unknown capability "${capability}"`,
      code: ERROR_CODES.INVALID_REQUEST,
    };
  }
  const spec = getCapabilitySpec(id);
  if (!spec) {
    return { ok: false, error: `Unknown capability "${id}"`, code: ERROR_CODES.INVALID_REQUEST };
  }
  // An empty body is a malformed response, not a silent pass. Guarding this
  // first is what prevents the "incorrect green/working indicator" class of
  // bug when an upstream returns 200 with nothing.
  const isEmptyBody = body === null || body === undefined;
  if (isEmptyBody && !spec.validate.includes("audio")) {
    return {
      ok: false,
      error: "Provider returned an empty response body",
      code: ERROR_CODES.MALFORMED,
    };
  }
  for (const token of spec.validate) {
    const validator = VALIDATORS[token];
    if (!validator) continue;
    const reason = validator(body, rawText, status);
    if (reason) {
      // A body that is not even JSON is malformed, whatever the capability.
      const code = typeof body === "string" || (rawText && /^\s*</.test(rawText))
        ? ERROR_CODES.MALFORMED
        : ERROR_CODES.PROVIDER;
      return { ok: false, error: reason, code };
    }
  }
  return { ok: true, error: null, code: null };
}

// ── Request construction ─────────────────────────────────────────

/**
 * A minimal, valid 1x1 PNG. Used as the image input for a vision test so the
 * request is real without fetching anything from the network.
 */
export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Build the request for a capability test. Pure.
 *
 * `settings` carries whatever the operation needs beyond the model id (an
 * image reference for vision, a voice for TTS, a path for custom). Missing
 * required settings produce an invalid_request up front — we never send a
 * request we know is malformed and then report the upstream's confusion.
 */
export function buildTestRequest({ capability, model, settings = {} } = {}) {
  const id = normalizeCapability(capability);
  if (!id) {
    return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: `Unknown capability "${capability}"` };
  }
  const spec = getCapabilitySpec(id);

  if (spec.requiresEndpointConfig && !isNonEmptyString(settings.endpoint)) {
    return {
      ok: false,
      code: ERROR_CODES.INVALID_REQUEST,
      error: "This custom operation needs an endpoint path before it can be tested",
    };
  }

  const base = { model, [id === "chat" || id === "vision" ? "stream" : "__never__"]: false };

  switch (id) {
    case "chat":
      return {
        ok: true,
        body: {
          model,
          max_tokens: 1,
          stream: false,
          messages: [{ role: "user", content: "hi" }],
        },
        timeoutMs: spec.timeoutMs,
      };

    case "vision": {
      // A real image input, inline as a data URL: no network fetch, valid
      // payload, and it genuinely exercises the multimodal path.
      const imageUrl = isNonEmptyString(settings.imageUrl)
        ? settings.imageUrl
        : `data:image/png;base64,${TINY_PNG_BASE64}`;
      return {
        ok: true,
        body: {
          model,
          max_tokens: 1,
          stream: false,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What color is this?" },
                { type: "image_url", image_url: { url: imageUrl } },
              ],
            },
          ],
        },
        timeoutMs: spec.timeoutMs,
      };
    }

    case "image":
      return {
        ok: true,
        body: {
          model,
          // A trivial prompt: the point is to prove the endpoint works, not to
          // produce a good picture. Keep n minimal to control cost.
          prompt: "a dot",
          n: 1,
          size: settings.size || "1024x1024",
        },
        timeoutMs: spec.timeoutMs,
      };

    case "video":
      return {
        ok: true,
        body: {
          model,
          prompt: "a dot",
          ...(isNonEmptyString(settings.size) ? { size: settings.size } : {}),
        },
        timeoutMs: spec.timeoutMs,
        async: true,
      };

    case "stt":
    case "audio": {
      if (settings.file == null) {
        return {
          ok: false,
          code: ERROR_CODES.INVALID_REQUEST,
          error: "Speech-to-text testing needs an audio file. Generate a small test clip or point the model at one.",
        };
      }
      return {
        ok: true,
        form: true,
        fields: { model, ...(isNonEmptyString(settings.language) ? { language: settings.language } : {}) },
        file: settings.file,
        filename: settings.filename || "test.wav",
        timeoutMs: spec.timeoutMs,
      };
    }

    case "tts": {
      if (!isNonEmptyString(settings.input)) {
        return {
          ok: false,
          code: ERROR_CODES.INVALID_REQUEST,
          error: "Text-to-speech testing needs some input text",
        };
      }
      return {
        ok: true,
        body: {
          model,
          input: settings.input,
          voice: settings.voice || "alloy",
        },
        timeoutMs: spec.timeoutMs,
      };
    }

    case "embedding":
      return {
        ok: true,
        body: { model, input: "test" },
        timeoutMs: spec.timeoutMs,
      };

    case "rerank": {
      const documents = Array.isArray(settings.documents) && settings.documents.length > 0
        ? settings.documents
        : ["test document one", "test document two"];
      return {
        ok: true,
        body: {
          model,
          query: settings.query || "test",
          documents,
          top_n: Math.min(documents.length, 2),
        },
        timeoutMs: spec.timeoutMs,
      };
    }

    case "custom":
      return {
        ok: true,
        body: {
          model,
          ...(settings.payload && typeof settings.payload === "object" ? settings.payload : {}),
        },
        endpoint: settings.endpoint,
        timeoutMs: spec.timeoutMs,
      };

    default:
      return { ok: false, code: ERROR_CODES.INVALID_REQUEST, error: `Unsupported capability "${id}"` };
  }
}

// ── I/O ─────────────────────────────────────────────────────────

async function getInternalHeaders(baseUrl) {
  let apiKey = null;
  try {
    const keys = await getApiKeys();
    apiKey = keys.find((k) => k.isActive !== false)?.key || null;
  } catch {}
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  headers["x-9r-cli-token"] = await getConsistentMachineId(CLI_TOKEN_SALT);
  return headers;
}

/** A short silent WAV, for speech-to-text tests that were not given a file. */
export function createSilentWavFile({ sampleRate = 16000, durationMs = 250 } = {}) {
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.max(1, Math.floor((sampleRate * durationMs) / 1000));
  const dataSize = sampleCount * channels * (bitsPerSample / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * (bitsPerSample / 8), true);
  view.setUint16(32, channels * (bitsPerSample / 8), true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Run ONE capability test against the local gateway.
 *
 * The gateway (not the provider) is called deliberately: it applies auth,
 * routing, the disabled-model check and provider selection, so a test result
 * reflects what would ACTUALLY happen for a real request.
 *
 * @returns {Promise<{ok, status, capability, error, errorCode, latencyMs, testedAt}>}
 */
export async function runCapabilityTest(model, capability, options = {}) {
  const id = normalizeCapability(capability);
  const started = Date.now();
  const baseUrl = options.baseUrl || `http://127.0.0.1:${process.env.PORT || 3001}`;

  const result = (ok, extra = {}) => ({
    ok,
    capability: id,
    status: options.persistStatus || id, // which capability was tested
    latencyMs: Date.now() - started,
    testedAt: new Date().toISOString(),
    error: null,
    errorCode: null,
    ...extra,
  });

  if (!id) return result(false, { error: `Unknown capability "${capability}"`, errorCode: ERROR_CODES.INVALID_REQUEST });
  if (typeof model !== "string" || !model.trim()) {
    return result(false, { error: "Model id required", errorCode: ERROR_CODES.INVALID_REQUEST });
  }

  const spec = getCapabilitySpec(id);
  const request = buildTestRequest({ capability: id, model: model.trim(), settings: options.settings || {} });
  if (!request.ok) return result(false, { error: request.error, errorCode: request.code });

  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : spec.timeoutMs;

  let headers;
  try {
    headers = await getInternalHeaders(baseUrl);
  } catch (err) {
    return result(false, { error: `Could not build internal headers: ${err?.message || err}`, errorCode: ERROR_CODES.UNKNOWN });
  }

  const path = request.endpoint
    ? `${baseUrl}${request.endpoint}`
    : `${baseUrl}${spec.endpoint}`;

  let init;
  if (request.form) {
    // Multipart: the Content-Type boundary is set by fetch, so it must be
    // dropped from our JSON headers.
    const form = new FormData();
    const file = request.file instanceof Blob ? request.file : createSilentWavFile();
    form.append("file", file, request.filename);
    for (const [key, value] of Object.entries(request.fields)) form.append(key, value);
    init = {
      method: spec.method,
      headers: Object.fromEntries(
        Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")
      ),
      body: form,
    };
  } else {
    init = { method: spec.method, headers, body: JSON.stringify(request.body) };
  }

  let response;
  try {
    response = await fetch(path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return result(false, {
      error: isTimeout ? `Timed out after ${timeoutMs}ms` : `Network error: ${err?.message || err}`,
      errorCode: isTimeout ? ERROR_CODES.TIMEOUT : classifyCapabilityError({ message: err?.message }),
    });
  }

  // Read the body EXACTLY ONCE (see lib/net/httpBody.js): the old
  // `if (ok) json() else text()` pattern consumed the stream and then threw
  // "Body is unusable" on any later read, masking the real upstream error.
  let rawText = "";
  let body = null;
  let parsed = false;
  try {
    const read = await readResponseOnce(response);
    rawText = read.text || "";
    body = read.parsed ? read.json : null;
    parsed = read.parsed;
  } catch (err) {
    return result(false, { error: `Could not read provider response: ${err?.message || err}`, errorCode: ERROR_CODES.MALFORMED });
  }

  if (!response.ok) {
    // NEVER echo the raw body: an upstream error page can reflect the
    // Authorization header back. parseErrorPayload extracts just the detail.
    const detail = parseErrorPayload(rawText, { status: response.status });
    const code = classifyCapabilityError({ status: response.status, body: detail });
    return result(false, {
      status: response.status,
      error: `HTTP ${response.status}${detail ? `: ${String(detail).slice(0, 240)}` : ""}`,
      errorCode: code,
    });
  }

  // A provider can return 200 while embedding an error in the body.
  const embeddedError = body && typeof body === "object" ? body.error : null;
  if (embeddedError) {
    const detail = embeddedError?.message || embeddedError;
    const providerStatus = body.status ?? body.code;
    const statusLooksErrored = providerStatus !== undefined
      && providerStatus !== null
      && String(providerStatus) !== "200"
      && String(providerStatus) !== "0";
    if (statusLooksErrored || (typeof embeddedError === "string" && embeddedError)) {
      return result(false, {
        error: String(detail).slice(0, 240),
        errorCode: classifyCapabilityError({
          status: Number(providerStatus) || response.status,
          body: String(detail),
        }),
      });
    }
  }

  // Non-JSON where JSON was expected is malformed, not a pass.
  if (!parsed && !spec.validate.includes("audio")) {
    return result(false, {
      error: "Provider returned a non-JSON response for this operation",
      errorCode: ERROR_CODES.MALFORMED,
    });
  }

  const verdict = validateCapabilityResponse({ capability: id, body, rawText, status: response.status });
  if (!verdict.ok) {
    return result(false, { status: response.status, error: verdict.error, errorCode: verdict.code });
  }

  return result(true, { status: response.status });
}
