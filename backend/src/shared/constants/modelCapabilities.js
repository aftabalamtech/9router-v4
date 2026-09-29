// Model capability registry — the single source of truth for what a model can
// do, where each operation lives, and how to test it.
//
// WHY THIS FILE EXISTS
// Capability used to be a single `type` field ("llm" | "image" | "video" |
// "embedding" | "stt" | "tts") plus an if/else chain in
// routes/models/test/ping.js that had branches for `embedding`, `image` and
// `stt` — and fell through to CHAT for everything else. Consequences:
//
//   - `vision`, `rerank` and custom operations did not exist at all.
//   - An image model asked to be tested as "audio" was probed with a chat
//     request, and that failure was indistinguishable from a broken model.
//   - Nothing could represent a model that does several things at once (most
//     modern chat models are also vision models).
//
// So capability is now a SET, and every operation has an explicit entry here
// with its own endpoint, request shape, validation and timeout. Both the
// backend test adapters and the Add Model modal read this table, so a new
// capability is added in one place.

/**
 * The canonical capability ids. These strings are persisted (in model
 * registration records and test results), so they are part of the on-disk
 * format: renaming one is a data migration, not a rename.
 */
export const MODEL_CAPABILITIES = Object.freeze([
  "chat",
  "image",
  "vision",
  "video",
  "audio",
  "stt",
  "tts",
  "embedding",
  "rerank",
  "custom",
]);

// Aliases accepted on input for convenience/back-compat. `llm` is what the old
// `type` field used for chat, and it is still what most of the catalogue and
// the routing layer speak, so it must always resolve.
const CAPABILITY_ALIASES = Object.freeze({
  llm: "chat",
  text: "chat",
  completion: "chat",
  "chat-completion": "chat",
  "text-generation": "chat",
  image_generation: "image",
  "image-generation": "image",
  // Lower-cased forms: normalizeCapability() lower-cases its input first, so a
  // camelCase catalogue value like "imageToText" arrives as "imagetotext" and
  // must be aliased in that form or it would silently resolve to null.
  imagetotext: "vision",
  "image-to-text": "vision",
  vision: "vision",
  multimodal: "vision",
  "video-generation": "video",
  audio: "audio",
  "speech-to-text": "stt",
  transcription: "stt",
  "text-to-speech": "tts",
  speech: "tts",
  embeddings: "embedding",
  embed: "embedding",
  reranking: "rerank",
  reranker: "rerank",
  "rank": "rerank",
  operation: "custom",
});

// Presentation + endpoint description for each capability.
//
//   endpoint        path appended to the gateway base URL (OpenAI-shaped). The
//                   adapter uses these for the built-in /v1 surface; a
//                   compatible provider's own base URL is normalized separately
//                   by lib/net/compatibleUrl.js.
//   method          HTTP method for the test request.
//   minFields       request fields that MUST be present for a test request to
//                   be meaningful; a missing one is an "invalid request", not
//                   an upstream failure.
//   timeoutMs       per-capability default. Image/video are slow and expensive,
//                   so they get a much longer budget than a chat ping.
//   cheap           false for operations where a test costs real money or
//                   minutes; the UI warns before running one.
export const CAPABILITY_SPECS = Object.freeze({
  chat: {
    id: "chat",
    label: "Chat / text generation",
    icon: "smart_toy",
    endpoint: "/v1/chat/completions",
    method: "POST",
    minFields: ["messages"],
    timeoutMs: 15000,
    cheap: true,
    // What a correct response must contain. A 200 with an empty body is a
    // failure, not a pass — that is the "incorrect green indicator" bug.
    validate: ["choices"],
  },
  image: {
    id: "image",
    label: "Image generation",
    icon: "brush",
    endpoint: "/v1/images/generations",
    method: "POST",
    minFields: ["prompt"],
    timeoutMs: 60000,
    cheap: false,
    validate: ["data"],
  },
  vision: {
    id: "vision",
    label: "Vision / image input",
    icon: "visibility",
    endpoint: "/v1/chat/completions",
    method: "POST",
    minFields: ["messages"],
    timeoutMs: 30000,
    cheap: true,
    // Vision is a chat call whose message must actually carry an image part.
    validate: ["choices"],
    requiresImageInput: true,
  },
  video: {
    id: "video",
    label: "Video generation",
    icon: "movie",
    endpoint: "/v1/video/generations",
    method: "POST",
    minFields: ["prompt"],
    timeoutMs: 120000,
    cheap: false,
    // Video is asynchronous on most providers: a job reference is returned
    // first and the final asset is polled. The adapter treats a returned job
    // id as success and the poll as a separate concern.
    validate: ["jobRef"],
    async: true,
  },
  audio: {
    id: "audio",
    label: "Audio processing",
    icon: "graphic_eq",
    endpoint: "/v1/audio/transcriptions",
    method: "POST",
    minFields: ["file"],
    timeoutMs: 30000,
    cheap: true,
    validate: ["text"],
  },
  stt: {
    id: "stt",
    label: "Speech to text",
    icon: "record_voice_over",
    endpoint: "/v1/audio/transcriptions",
    method: "POST",
    minFields: ["file"],
    timeoutMs: 30000,
    cheap: true,
    validate: ["text"],
  },
  tts: {
    id: "tts",
    label: "Text to speech",
    icon: "campaign",
    endpoint: "/v1/audio/speech",
    method: "POST",
    minFields: ["input"],
    timeoutMs: 30000,
    cheap: false,
    // TTS returns raw audio bytes, not JSON — validation is on the payload
    // being non-empty audio, not on a JSON field.
    validate: ["audio"],
  },
  embedding: {
    id: "embedding",
    label: "Embeddings",
    icon: "data_array",
    endpoint: "/v1/embeddings",
    method: "POST",
    minFields: ["input"],
    timeoutMs: 30000,
    cheap: true,
    validate: ["vector"],
  },
  rerank: {
    id: "rerank",
    label: "Reranking",
    icon: "sort",
    endpoint: "/v1/rerank",
    method: "POST",
    minFields: ["query", "documents"],
    timeoutMs: 30000,
    cheap: true,
    validate: ["rankedResults"],
  },
  custom: {
    id: "custom",
    label: "Custom operation",
    icon: "extension",
    // No endpoint is claimed: the user configures the path on the model.
    endpoint: "",
    method: "POST",
    minFields: [],
    timeoutMs: 30000,
    cheap: true,
    validate: ["ok"],
    requiresEndpointConfig: true,
  },
});

/** Test result statuses. "unsupported" is NOT a failure. */
export const TEST_STATUSES = Object.freeze([
  "working",
  "error",
  "untested",
  "unsupported",
]);

export const TEST_STATUS = Object.freeze({
  WORKING: "working",
  ERROR: "error",
  UNTESTED: "untested",
  UNSUPPORTED: "unsupported",
});

/**
 * Normalize a single capability value to a canonical id.
 * Returns null for anything unrecognised — callers must not guess a default,
 * because guessing "chat" is exactly the bug this module exists to fix.
 */
export function normalizeCapability(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (MODEL_CAPABILITIES.includes(raw)) return raw;
  const aliased = CAPABILITY_ALIASES[raw];
  return aliased || null;
}

/** Normalize an array/list of capabilities, dropping unknown ones, de-duped. */
export function normalizeCapabilities(values) {
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  const out = [];
  for (const value of list) {
    const id = normalizeCapability(value);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Spec for a capability, or null when unknown. */
export function getCapabilitySpec(value) {
  const id = normalizeCapability(value);
  return id ? CAPABILITY_SPECS[id] : null;
}

export function isKnownCapability(value) {
  return normalizeCapability(value) !== null;
}

/**
 * Legacy `type` -> capability set.
 *
 * The catalogue and the routing layer still carry a single `type`, so this is
 * the bridge. Note the important case: an `imageToText` type maps to `vision`,
 * NOT to `chat` — that is the classification that was previously impossible.
 */
export function capabilitiesFromType(type) {
  // Routed through normalizeCapability so the legacy switch below can never
  // disagree with the alias table: one vocabulary, one place to fix it.
  const id = normalizeCapability(type);
  if (!id) return [];
  if (id === "chat") return ["chat"];
  return [id];
}

/**
 * The capability used when a test must pick exactly one operation for a model
 * that declares several. Chat is the conventional default, but callers should
 * pass an explicit capability whenever they know it — this exists only so a
 * legacy single-`type` caller keeps working.
 */
export function defaultCapabilityFor(types) {
  const list = normalizeCapabilities(types);
  if (list.length === 0) return null;
  if (list.includes("chat")) return "chat";
  return list[0];
}

/**
 * Map the Auto-Add capability filter ids (llm/image/video/audio/embedding) onto
 * canonical capabilities. The filter vocabulary is coarser than the capability
 * vocabulary on purpose: it is a UI control, not a storage format.
 */
export function capabilityMatchesFilter(capability, filterKinds) {
  const kinds = normalizeCapabilities(filterKinds);
  if (kinds.length === 0) return true; // empty filter = no filter
  return kinds.includes(normalizeCapability(capability));
}

// ── Registered model ids ─────────────────────────────────────────
//
// A registered id is "<prefix>/<modelId>". This lives in the SHARED module
// (not in a backend-only helper) because the requirement is that the id is
// validated and composed IDENTICALLY by model selection, routing, testing and
// the Playground. Two copies would drift, and a drifted copy produces ids that
// register under one prefix and route under another.

export const CAPABILITY_KEY_SEP = "#";

/**
 * Split on the FIRST slash only. Upstream ids legitimately contain slashes
 * ("anthropic/claude-3", "openai/gpt-4o"), so splitting on the last slash, or
 * on every slash, silently corrupts the id and breaks routing.
 */
export function splitRegisteredId(registeredId) {
  const raw = String(registeredId || "");
  const slash = raw.indexOf("/");
  if (slash <= 0) return { prefix: "", modelId: raw, valid: false };
  return { prefix: raw.slice(0, slash), modelId: raw.slice(slash + 1), valid: Boolean(raw.slice(slash + 1)) };
}

/**
 * Compose "<prefix>/<modelId>", applying the prefix exactly once. Re-adding an
 * already-qualified id under the same prefix must not produce "ag/ag/x".
 */
export function buildRegisteredId(prefix, modelId) {
  const p = String(prefix || "").trim();
  const m = String(modelId || "").trim();
  if (!p || !m) return "";
  const stripped = m.startsWith(`${p}/`) ? m.slice(p.length + 1) : m;
  return `${p}/${stripped}`;
}

// A prefix becomes a path segment in the registered id, so it is restricted to
// the shape the router already accepts. Rejecting at registration is far better
// than producing an id that silently routes nowhere.
export function isValidPrefix(prefix) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(String(prefix || "").trim());
}

export function isValidModelId(modelId) {
  const m = String(modelId || "").trim();
  return m.length > 0 && m.length <= 200 && !/\s/.test(m);
}
