// Redaction helper for anything written to the server log.
//
// The log is a shared diagnostic surface: an upstream error page, a stack, or a
// client error report can all contain a credential. Every string that reaches a
// log line goes through here first.
//
// Applied to log output only — it is deliberately lossy on anything that looks
// credential-shaped, because a mangled log line is far cheaper than a key in a
// log file.

const PATTERNS = [
  // Authorization / cookie headers and JSON-ish field assignments.
  [/\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\n]*/gi, "$1: [redacted]"],
  [/\b(x-api-key|x-goog-api-key|openai-api-key)\s*[:=]\s*[^\s,;"']+/gi, "$1=[redacted]"],
  // Bearer tokens and JWTs anywhere.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, "[redacted-jwt]"],
  // Common provider key shapes (sk-..., ghp_..., xai-..., AIza...).
  [/\b(sk|pk|rk|xai|ghp|gho|ghs|nvapi|hf)[-_][A-Za-z0-9._-]{12,}\b/gi, "[redacted-key]"],
  [/\bAIza[A-Za-z0-9_-]{20,}\b/g, "[redacted-key]"],
  // key=value pairs in query strings. No leading \b: the match can start the
  // string, and `?` is not a word character so a boundary would never match.
  [/([?&](?:key|api_key|apikey|access_token|token|secret)=)[^&\s]+/gi, "$1[redacted]"],
  // Bare `token=...` / `auth=...` assignments anywhere in free text, not only in
  // a query string — a token is just as sensitive in a stack frame as in a URL.
  [/\b(token|auth|session|sid)\s*=\s*[A-Za-z0-9._-]{10,}/gi, "$1=[redacted]"],
  // Generic secret-ish assignments in free text.
  [/\b(password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*("?)[^\s,;"']{4,}\2/gi, "$1=[redacted]"],
];

/**
 * Scrub credential-shaped substrings from a log-bound string.
 * Non-strings are returned as an empty string so a caller can never splice an
 * object into a log line by accident.
 */
export function scrubLogText(value) {
  if (typeof value !== "string") return "";
  let out = value;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

export default scrubLogText;
