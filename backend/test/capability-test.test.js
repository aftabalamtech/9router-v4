// Capability registry + per-capability test adapters.
//
// This is the core of the change, so these tests drive the REAL modules rather
// than a mirror: a mirror of the validation rules would pass while the actual
// code regressed.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MODEL_CAPABILITIES,
  CAPABILITY_SPECS,
  TEST_STATUS,
  normalizeCapability,
  normalizeCapabilities,
  getCapabilitySpec,
  capabilitiesFromType,
  defaultCapabilityFor,
  capabilityMatchesFilter,
} from "../src/shared/constants/modelCapabilities.js";

import {
  validateCapabilityResponse,
  buildTestRequest,
  classifyCapabilityError,
  ERROR_CODES,
  TINY_PNG_BASE64,
} from "../src/lib/models/capabilityTest.js";

// ── Registry ─────────────────────────────────────────────────────

test("the registry covers every capability the UI must offer", () => {
  assert.deepEqual([...MODEL_CAPABILITIES], [
    "chat", "image", "vision", "video", "audio", "stt", "tts", "embedding", "rerank", "custom",
  ]);
});

test("every capability has a complete spec", () => {
  for (const id of MODEL_CAPABILITIES) {
    const spec = CAPABILITY_SPECS[id];
    assert.ok(spec, `${id} has a spec`);
    assert.equal(spec.id, id);
    assert.ok(spec.label, `${id} has a label`);
    // A timeout is required: it is what keeps a slow operation from being
    // given the chat budget (and hanging the UI).
    assert.ok(spec.timeoutMs > 0, `${id} has a timeout`);
    assert.ok(Array.isArray(spec.validate) && spec.validate.length > 0, `${id} has validators`);
  }
});

test("the legacy llm type still resolves to chat", () => {
  // Almost the whole catalogue and the routing layer still speak "llm".
  assert.equal(normalizeCapability("llm"), "chat");
  assert.equal(normalizeCapability("LLM"), "chat");
  assert.equal(normalizeCapability("chat"), "chat");
  assert.equal(capabilitiesFromType("llm")[0], "chat");
});

test("imageToText maps to vision, not to chat", () => {
  // The classification that was impossible when capability was a single `type`.
  assert.equal(normalizeCapability("imageToText"), "vision");
  assert.deepEqual(capabilitiesFromType("imageToText"), ["vision"]);
  assert.notEqual(capabilitiesFromType("imageToText")[0], "chat");
});

test("an unknown capability resolves to null instead of defaulting to chat", () => {
  // Defaulting unknown input to "chat" is the original bug: an image model
  // silently gets probed with a chat request.
  for (const value of ["banana", "", null, undefined, 42, {}, "chat-completion-typo"]) {
    if (value === "chat-completion-typo") {
      assert.equal(normalizeCapability(value), null);
      continue;
    }
    assert.equal(normalizeCapability(value), null, `${value} must not resolve`);
  }
  assert.equal(getCapabilitySpec("banana"), null);
});

test("capability lists are normalized, de-duped and order-preserving", () => {
  assert.deepEqual(normalizeCapabilities(["llm", "chat", "llm", "image"]), ["chat", "image"]);
  assert.deepEqual(normalizeCapabilities("image"), ["image"]);
  assert.deepEqual(normalizeCapabilities(null), []);
  // Unknown entries are dropped, not turned into chat.
  assert.deepEqual(normalizeCapabilities(["banana", "image"]), ["image"]);
});

test("slow or expensive operations get their own budgets", () => {
  // Image and video are slow and cost real money; they must not inherit the
  // chat timeout or they would be reported as failures.
  assert.ok(CAPABILITY_SPECS.video.timeoutMs > CAPABILITY_SPECS.chat.timeoutMs);
  assert.ok(CAPABILITY_SPECS.image.timeoutMs > CAPABILITY_SPECS.chat.timeoutMs);
  assert.equal(CAPABILITY_SPECS.image.cheap, false);
  assert.equal(CAPABILITY_SPECS.video.cheap, false);
  assert.equal(CAPABILITY_SPECS.chat.cheap, true);
  assert.equal(CAPABILITY_SPECS.video.async, true);
});

test("a single-type model resolves to one capability, chat preferred", () => {
  assert.equal(defaultCapabilityFor(["llm"]), "chat");
  assert.equal(defaultCapabilityFor(["image", "chat"]), "chat");
  assert.equal(defaultCapabilityFor(["image"]), "image");
  assert.equal(defaultCapabilityFor([]), null);
});

test("the auto-add capability filter is coarse and defaults to no filter", () => {
  assert.equal(capabilityMatchesFilter("chat", []), true);
  assert.equal(capabilityMatchesFilter("image", ["llm"]), false);
  assert.equal(capabilityMatchesFilter("image", ["image"]), true);
  assert.equal(capabilityMatchesFilter("chat", ["image", "llm"]), true);
});

// ── Error classification ─────────────────────────────────────────

test("failures are classified into the documented categories", () => {
  assert.equal(classifyCapabilityError({ status: 401 }), ERROR_CODES.AUTH);
  assert.equal(classifyCapabilityError({ status: 403 }), ERROR_CODES.AUTH);
  assert.equal(classifyCapabilityError({ status: 429 }), ERROR_CODES.RATE_LIMITED);
  assert.equal(classifyCapabilityError({ status: 400, message: "rate limit exceeded" }), ERROR_CODES.RATE_LIMITED);
  assert.equal(classifyCapabilityError({ message: "Request timed out" }), ERROR_CODES.TIMEOUT);
  assert.equal(classifyCapabilityError({ message: "ECONNREFUSED" }), ERROR_CODES.NETWORK);
  assert.equal(classifyCapabilityError({ message: "fetch failed" }), ERROR_CODES.NETWORK);
  assert.equal(classifyCapabilityError({ status: 400, message: "model_not_found" }), ERROR_CODES.NOT_FOUND);
  assert.equal(classifyCapabilityError({ status: 500 }), ERROR_CODES.PROVIDER);
  assert.equal(classifyCapabilityError({}), ERROR_CODES.UNKNOWN);
});

test("an unsupported operation is classified as unsupported, not as a failure", () => {
  // This is the requirement that a capability the provider does not offer must
  // never be reported as a failed test. A 404 from a missing endpoint is the
  // common case, so the message check must win over the status check.
  assert.equal(
    classifyCapabilityError({ status: 404, message: "Not Found: this endpoint is not supported" }),
    ERROR_CODES.UNSUPPORTED
  );
  assert.equal(
    classifyCapabilityError({ status: 404, message: "unknown endpoint" }),
    ERROR_CODES.UNSUPPORTED
  );
  assert.equal(
    classifyCapabilityError({ status: 400, message: "unsupported operation" }),
    ERROR_CODES.UNSUPPORTED
  );
});

test("the gateway's 'does not support' wording is classified as unsupported", () => {
  // Observed live: POST /v1/embeddings for a chat-only provider answers
  // 400 "Provider 'opencode' does not support embeddings." Reporting that as a
  // generic provider error would show a red failure for an operation the
  // provider never offered.
  for (const message of [
    "Provider 'opencode' does not support embeddings.",
    "Provider 'x' does not support image generation",
    "This provider does not support speech to text",
  ]) {
    assert.equal(
      classifyCapabilityError({ status: 400, message }),
      ERROR_CODES.UNSUPPORTED,
      message
    );
  }
});

test("a real failure is still a failure, not unsupported", () => {
  // The unsupported patterns must not swallow genuine 4xx errors.
  assert.equal(classifyCapabilityError({ status: 400, message: "invalid temperature" }), ERROR_CODES.PROVIDER);
  assert.equal(classifyCapabilityError({ status: 422, message: "prompt too long" }), ERROR_CODES.PROVIDER);
  assert.equal(classifyCapabilityError({ status: 500 }), ERROR_CODES.PROVIDER);
});

// ── Request building ─────────────────────────────────────────────

test("each capability builds a request for its own endpoint shape", () => {
  const chat = buildTestRequest({ capability: "chat", model: "oc/gpt-4o" });
  assert.equal(chat.ok, true);
  assert.equal(chat.body.model, "oc/gpt-4o");
  assert.equal(chat.body.stream, false);
  assert.ok(chat.body.messages?.length);

  const emb = buildTestRequest({ capability: "embedding", model: "oc/text-embedding-3-small" });
  assert.equal(emb.ok, true);
  assert.ok("input" in emb.body);
  assert.equal(emb.body.messages, undefined);

  const image = buildTestRequest({ capability: "image", model: "oc/dalle" });
  assert.equal(image.ok, true);
  assert.equal(image.body.prompt, "a dot");
  // Keep generation minimal: a test must not cost a real rendering.
  assert.equal(image.body.n, 1);

  const video = buildTestRequest({ capability: "video", model: "oc/veo" });
  assert.equal(video.ok, true);
  assert.equal(video.async, true);

  const tts = buildTestRequest({ capability: "tts", model: "oc/tts-1", settings: { input: "hello" } });
  assert.equal(tts.ok, true);
  assert.equal(tts.body.input, "hello");
});

test("a vision test carries a real inline image", () => {
  // A vision test that sends no image would pass for a text-only model and
  // prove nothing about the multimodal path.
  const v = buildTestRequest({ capability: "vision", model: "oc/gemini", settings: {} });
  assert.equal(v.ok, true);
  const parts = v.body.messages[0].content;
  assert.equal(parts.length, 2);
  const imagePart = parts.find((p) => p.type === "image_url");
  assert.ok(imagePart, "vision request must include an image part");
  assert.ok(imagePart.image_url.url.startsWith("data:image/png;base64,"));
  assert.ok(imagePart.image_url.url.includes(TINY_PNG_BASE64.slice(0, 20)));
});

test("a user-supplied image is used when provided", () => {
  const v = buildTestRequest({
    capability: "vision",
    model: "oc/gemini",
    settings: { imageUrl: "https://example.test/x.png" },
  });
  const parts = v.body.messages[0].content;
  assert.equal(parts.find((p) => p.type === "image_url").image_url.url, "https://example.test/x.png");
});

test("a malformed test request is refused before it reaches the provider", () => {
  // Sending a request we know is broken and reporting the upstream's confusion
  // produces useless failures, so these are rejected up front.
  const noAudio = buildTestRequest({ capability: "stt", model: "oc/whisper", settings: {} });
  assert.equal(noAudio.ok, false);
  assert.equal(noAudio.code, ERROR_CODES.INVALID_REQUEST);

  const noText = buildTestRequest({ capability: "tts", model: "oc/tts-1", settings: {} });
  assert.equal(noText.ok, false);
  assert.equal(noText.code, ERROR_CODES.INVALID_REQUEST);

  const noEndpoint = buildTestRequest({ capability: "custom", model: "oc/x", settings: {} });
  assert.equal(noEndpoint.ok, false);
  assert.equal(noEndpoint.code, ERROR_CODES.INVALID_REQUEST);

  const unknown = buildTestRequest({ capability: "banana", model: "oc/x", settings: {} });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, ERROR_CODES.INVALID_REQUEST);
});

test("rerank always sends documents and a query", () => {
  const r = buildTestRequest({ capability: "rerank", model: "oc/reranker", settings: {} });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.body.documents) && r.body.documents.length > 0);
  assert.ok(r.body.query);
});

test("custom operations carry the configured endpoint and payload", () => {
  const c = buildTestRequest({
    capability: "custom",
    model: "oc/thing",
    settings: { endpoint: "/v1/thing", payload: { mode: "fast" } },
  });
  assert.equal(c.ok, true);
  assert.equal(c.endpoint, "/v1/thing");
  assert.equal(c.body.mode, "fast");
  assert.equal(c.body.model, "oc/thing");
});

test("speech-to-text sends multipart with a file", () => {
  const s = buildTestRequest({ capability: "stt", model: "oc/whisper", settings: { file: "blob" } });
  assert.equal(s.ok, true);
  assert.equal(s.form, true);
  assert.equal(s.file, "blob");
  assert.equal(s.fields.model, "oc/whisper");
});

// ── Response validation ──────────────────────────────────────────

test("a valid chat response passes", () => {
  const r = validateCapabilityResponse({
    capability: "chat",
    body: { choices: [{ message: { content: "hi" } }] },
  });
  assert.equal(r.ok, true);
});

test("a chat tool call counts as a valid response", () => {
  // A model that replies with a tool call and no text is working, not broken.
  const r = validateCapabilityResponse({
    capability: "chat",
    body: { choices: [{ message: { tool_calls: [{ id: "1", function: { name: "f" } }] } }] },
  });
  assert.equal(r.ok, true);
});

test("a 200 with an empty body is a failure, not a pass", () => {
  // The "incorrect green/working indicator" case.
  for (const body of [null, undefined, {}]) {
    const r = validateCapabilityResponse({ capability: "chat", body });
    assert.equal(r.ok, false, `${JSON.stringify(body)} must not pass`);
    assert.ok(r.error);
  }
  const emptyChoices = validateCapabilityResponse({ capability: "chat", body: { choices: [] } });
  assert.equal(emptyChoices.ok, false);
  const noContent = validateCapabilityResponse({
    capability: "chat",
    body: { choices: [{ message: { content: "" } }] },
  });
  assert.equal(noContent.ok, false);
  assert.match(noContent.error, /no content/i);
});

test("a non-object body is rejected rather than crashing", () => {
  for (const body of ["a string", 42, true, []]) {
    const r = validateCapabilityResponse({ capability: "chat", body });
    assert.equal(r.ok, false, `${JSON.stringify(body)} must not pass`);
  }
});

test("image responses need a usable image reference", () => {
  assert.equal(validateCapabilityResponse({ capability: "image", body: { data: [{ url: "https://x/y.png" }] } }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "image", body: { data: [{ b64_json: "abc" }] } }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "image", body: { data: [] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "image", body: { data: [{}] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "image", body: { data: [{ url: "" }] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "image", body: {} }).ok, false);
});

test("embeddings require a real numeric vector", () => {
  assert.equal(validateCapabilityResponse({ capability: "embedding", body: { data: [{ embedding: [0.1, 0.2] }] } }).ok, true);
  // The shapes that used to slip through as "working".
  assert.equal(validateCapabilityResponse({ capability: "embedding", body: { data: [{ embedding: [] }] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "embedding", body: { data: [{ embedding: ["a", "b"] }] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "embedding", body: { data: [{ embedding: [null, 1] }] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "embedding", body: { data: [{ embedding: [NaN] }] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "embedding", body: { data: [] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "embedding", body: {} }).ok, false);
});

test("speech-to-text requires transcription text", () => {
  assert.equal(validateCapabilityResponse({ capability: "stt", body: { text: "hello" } }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "stt", body: { text: "  " } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "stt", body: { text: "" } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "stt", body: {} }).ok, false);
});

test("text-to-speech accepts audio bytes or a wrapped reference", () => {
  assert.equal(validateCapabilityResponse({ capability: "tts", body: null, rawText: "x".repeat(100) }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "tts", body: { audio: "base64data" } }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "tts", body: { url: "https://x/a.mp3" } }).ok, true);
  // A tiny non-audio payload is not audio.
  assert.equal(validateCapabilityResponse({ capability: "tts", body: null, rawText: "nope" }).ok, false);
});

test("video responses need a job reference", () => {
  for (const body of [
    { id: "job-1" },
    { job_id: "job-1" },
    { task_id: "job-1" },
    { data: { id: "job-1" } },
  ]) {
    assert.equal(validateCapabilityResponse({ capability: "video", body }).ok, true, JSON.stringify(body));
  }
  assert.equal(validateCapabilityResponse({ capability: "video", body: {} }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "video", body: { id: "" } }).ok, false);
});

test("rerank responses need ranked documents", () => {
  assert.equal(validateCapabilityResponse({ capability: "rerank", body: { results: [{ index: 0, relevance_score: 0.9 }] } }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "rerank", body: { data: [{ document: { text: "a" } }] } }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "rerank", body: { results: [] } }).ok, false);
  assert.equal(validateCapabilityResponse({ capability: "rerank", body: {} }).ok, false);
  // A result with no document reference cannot be used.
  assert.equal(validateCapabilityResponse({ capability: "rerank", body: { results: [{ score: 1 }] } }).ok, false);
  // A non-numeric score is malformed, even though the document is there.
  assert.equal(
    validateCapabilityResponse({ capability: "rerank", body: { results: [{ index: 0, relevance_score: "high" }] } }).ok,
    false
  );
});

test("a custom operation accepts any non-error response", () => {
  assert.equal(validateCapabilityResponse({ capability: "custom", body: { anything: 1 } }).ok, true);
  assert.equal(validateCapabilityResponse({ capability: "custom", body: null }).ok, false);
});

test("an unknown capability is an invalid request, never a silent pass", () => {
  const r = validateCapabilityResponse({ capability: "banana", body: { choices: [] } });
  assert.equal(r.ok, false);
  assert.equal(r.code, ERROR_CODES.INVALID_REQUEST);
});
