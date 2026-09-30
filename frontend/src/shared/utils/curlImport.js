const SUPPORTED_VALUE_FLAGS = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--url"]);
const SUPPORTED_FLAGS = new Set(["-s", "-S", "-sS", "-L", "--silent", "--show-error", "--location", "--compressed"]);

// Tokenize shell-like quoting and backslash-newline continuations. This only
// parses text; it never invokes a shell or evaluates substitutions.
function tokenizeCurl(command) {
  const input = String(command || "").replace(/\\\r?\n/g, " ");
  const tokens = [];
  let token = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (quote === "'") {
      if (char === "'") quote = null;
      else token += char;
      started = true;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && i + 1 < input.length && ['"', "\\", "$", "`"].includes(input[i + 1])) token += input[++i];
      else token += char;
      started = true;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < input.length) {
      token += input[++i];
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Malformed cURL: unmatched quote");
  if (started) tokens.push(token);
  return tokens;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}

export function parseCurlImport(command) {
  const tokens = tokenizeCurl(command);
  if (!tokens.length || !/^curl(?:\.exe)?$/i.test(tokens[0])) throw new Error("Paste a cURL command beginning with curl.");
  let method = "GET";
  let urlText = "";
  let data = null;
  const headers = {};
  const unsupported = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const arg = tokens[i];
    if (SUPPORTED_FLAGS.has(arg)) continue;
    if (SUPPORTED_VALUE_FLAGS.has(arg)) {
      const value = tokens[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}.`);
      if (arg === "-X" || arg === "--request") method = value.toUpperCase();
      else if (arg === "--url") urlText = value;
      else if (arg === "-H" || arg === "--header") {
        const colon = value.indexOf(":");
        if (colon < 1) { unsupported.push(`Header not parsed: ${value.slice(0, 32)}`); continue; }
        headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
      } else data = value;
      continue;
    }
    if (arg.startsWith("--") || (arg.startsWith("-") && arg !== "-")) unsupported.push(`Unsupported option: ${arg}`);
    else if (!urlText) urlText = arg;
    else unsupported.push(`Unrecognized argument: ${arg.slice(0, 32)}`);
  }
  if (data !== null && method === "GET") method = "POST";
  const parsedUrl = safeUrl(urlText);
  if (!parsedUrl) throw new Error("cURL command must include valid http(s) URL.");
  let body = null;
  if (data !== null) {
    try { body = JSON.parse(data); }
    catch { unsupported.push("Request body is not valid JSON; body was not imported."); }
  }
  const fullPath = parsedUrl.pathname.replace(/\/$/, "");
  const suffix = fullPath.match(/\/(chat\/completions|responses)$/i);
  const endpoint = suffix ? suffix[1].toLowerCase() : "";
  if (endpoint) parsedUrl.pathname = parsedUrl.pathname.replace(/\/(chat\/completions|responses)\/?$/i, "");
  parsedUrl.search = "";
  parsedUrl.hash = "";
  const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === "authorization")?.[1] || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const apiKeyHeader = Object.entries(headers).find(([key]) => /^(?:x-api-key|api-key)$/i.test(key))?.[1] || "";
  const secretInCommand = Boolean(bearer || apiKeyHeader || Object.entries(headers).some(([key]) => /api[-_]key/i.test(key)));
  return {
    method,
    baseUrl: parsedUrl.toString().replace(/\/$/, ""),
    endpoint,
    apiType: endpoint === "responses" ? "responses" : "chat",
    modelId: typeof body?.model === "string" ? body.model : "",
    apiKey: bearer || apiKeyHeader,
    headers: Object.fromEntries(Object.entries(headers).filter(([key]) => !/^(authorization|content-type|accept|x-api-key|api-key)$/i.test(key)).map(([key, value]) => [key, /key|token|secret|auth/i.test(key) ? "••••••" : value])),
    customHeaderNames: Object.keys(headers).filter((key) => !/^(authorization|content-type|accept)$/i.test(key)),
    hasCredentials: secretInCommand,
    unsupported,
  };
}

export function maskCurlSecrets(command) {
  return String(command || "")
    .replace(/(authorization\s*:\s*bearer\s+)[^'"\s]+/ig, "$1••••••")
    .replace(/((?:x-api-key|api-key|api_key)\s*:\s*)[^'"\s]+/ig, "$1••••••");
}
