// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// OpenCode models that can never work through the chat flow — keep them out of
// chat suggestions (verified 2026-09-20): jev-*-free are SystemOne decision
// models (separate /systemone endpoint); deepseek-v4-flash-free currently
// returns "Model is unavailable" upstream.
const EXCLUDED_OPENCODE_MODELS = new Set(["jev-1.13-free", "deepseek-v4-flash-free"]);

export const FILTERS = {
  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !EXCLUDED_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),
};
