// Bulk API-key import parsing (shared, pure).
//
// Accepts both supported input shapes:
//
//   sk-key-1                       → auto-named "Key 1"
//   Main | sk-key-1                → explicit name
//
// Design constraints:
//  - NEVER returns or logs a key. Callers receive keys only to pass straight
//    to the persistence layer; error strings are built from names/line numbers
//    exclusively.
//  - One invalid line never discards the valid ones — each line is validated
//    independently and reported per entry.
//  - Duplicates are detected by value WITHOUT ever echoing the value, and
//    duplicates within the paste are collapsed before any write.
//
// Pure module: no DB, no fetch — unit-testable with `node --test`.

const MAX_ENTRIES = 500;
const MAX_KEY_LENGTH = 512;
const MIN_KEY_LENGTH = 4;

const MAX_LINE_LENGTH = 2000;

/**
 * Strip anything that looks like a credential out of a string that is about to
 * be persisted in a user-facing error message.
 */
export function redactSecrets(value) {
  if (typeof value !== "string") return "";
  // Each pattern keeps a named prefix group so the redaction stays readable
  // ("Bearer [redacted]") instead of eating the surrounding context.
  const rules = [
    [/(Bearer)(\s+)[A-Za-z0-9\-._~+/=]{6,}/gi, "$1$2[redacted]"],
    [/(sk-)[A-Za-z0-9-_]{4,}/g, "$1[redacted]"],
    [/[A-Za-z0-9\-._~+/=]{24,}/g, "[redacted]"],
  ];
  let out = value;
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out.slice(0, 200);
}

function validateKeyShape(key) {
  if (!key) return "missing key";
  if (key.length > MAX_KEY_LENGTH) return "key too long";
  if (key.length < MIN_KEY_LENGTH) return "key too short";
  if (key.length >= 24) return null; // long vendor keys are legitimately dense
  if (!/^[\x21-\x7e]+$/.test(key)) return "key contains unsupported characters";
  // Reject whitespace and control characters: a pasted line is a single token.
  if (/\s/.test(key)) return "key contains whitespace";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) return "key contains control characters";
  return null;
}

function deriveName(index) {
  return `Key ${index + 1}`;
}

/**
 * Parse pasted bulk input.
 *
 * @param {string} text raw textarea content
 * @param {object} [options]
 * @param {string[]} [options.existingKeys] keys already configured (for dup
 *        detection). Never echoed back.
 * @param {string} [options.namePrefix] used to auto-name unnamed entries
 * @returns {{entries: Array<{index:number,name:string,apiKey:string,duplicate:boolean}>,
 *            errors: Array<{index:number,line:number,name?:string,error:string}>,
 *            total:number}}
 */
export function parseBulkKeys(text, { existingKeys = [], namePrefix = "" } = {}) {
  const rawLines = String(text || "").split(/\r?\n/);
  const existing = new Set((existingKeys || []).filter((k) => typeof k === "string" && k));
  const entries = [];
  const errors = [];
  const seen = new Set();
  let total = 0;

  for (let i = 0; i < rawLines.length; i += 1) {
    const rawLine = rawLines[i].trim();
    if (!rawLine) continue;
    total += 1;
    if (total > MAX_ENTRIES) {
      errors.push({ index: i, line: i + 1, error: `Too many entries (max ${MAX_ENTRIES})` });
      break;
    }

    // `Name | key`. A pipe is ambiguous (some vendor keys contain one), so try
    // the FIRST pipe first — the common `Name | key` shape — and fall back to
    // the LAST pipe when that does not yield a usable key. Whichever split
    // produces a valid key wins; a line with no pipe is a bare key.
    const splitNamed = (pipeAt) => {
      const maybeName = rawLine.slice(0, pipeAt).trim();
      const maybeKey = rawLine.slice(pipeAt + 1).trim();
      if (!maybeKey) return null;
      return { name: maybeName, apiKey: maybeKey };
    };
    let name = "";
    let apiKey = rawLine;
    if (rawLine.includes("|")) {
      const first = splitNamed(rawLine.indexOf("|"));
      const last = rawLine.lastIndexOf("|") !== rawLine.indexOf("|")
        ? splitNamed(rawLine.lastIndexOf("|"))
        : null;
      const chosen = first && !validateKeyShape(first.apiKey) ? first : (last || first);
      if (chosen) {
        name = chosen.name;
        apiKey = chosen.apiKey;
      }
    }

    const shapeError = validateKeyShape(apiKey);
    if (shapeError) {
      // Report the line number and a redacted reason — never the key.
      errors.push({
        index: entries.length + errors.length,
        line: i + 1,
        name: name || undefined,
        error: `Invalid entry: ${shapeError}`,
      });
      continue;
    }

    const duplicate = existing.has(apiKey) || seen.has(apiKey);
    if (duplicate) {
      errors.push({
        index: entries.length + errors.length,
        line: i + 1,
        name: name || undefined,
        error: existing.has(apiKey) ? "Duplicate key (already configured)" : "Duplicate key in this paste",
      });
      continue;
    }
    seen.add(apiKey);

    entries.push({
      index: entries.length,
      line: i + 1,
      name: name || (namePrefix ? `${namePrefix} ${entries.length + 1}` : deriveName(entries.length)),
      apiKey,
      duplicate: false,
    });
  }

  return { entries, errors, total };
}
