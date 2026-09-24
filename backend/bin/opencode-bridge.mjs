#!/usr/bin/env node
/**
 * opencode-bridge — OpenAI-compatible HTTP facade over the LOCAL OpenCode client.
 *
 * Why this exists:
 *   OpenCode's Zen free tier rejects anonymous/third-party calls server-side:
 *       403 FreeTierError: "OpenCode's free tier can only be used from within OpenCode"
 *   The official OpenCode client CAN use those $0 models (no account needed), so this
 *   bridge accepts OpenAI /v1 requests and replays them through the local OpenCode
 *   background service — i.e. the model calls genuinely happen "from within OpenCode".
 *
 * Endpoints (OpenAI shape, bound to 127.0.0.1 only):
 *   GET  /health
 *   GET  /v1/models
 *   POST /v1/chat/completions      (stream: true|false)
 *
 * Config (env, all optional):
 *   OC_BRIDGE_PORT            listen port            (default 3010)
 *   OPENCODE_SERVICE_URL      e.g. http://127.0.0.1:49374  (default: discovered)
 *   OPENCODE_SERVICE_USER     basic-auth user        (default "opencode")
 *   OPENCODE_SERVICE_PASSWORD basic-auth password    (default: ~/.config/opencode/service.json)
 *   OC_BRIDGE_TIMEOUT_MS      per-request deadline   (default 150000)
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.OC_BRIDGE_PORT) || 3010;
const HOST = "127.0.0.1";
const PROVIDER_ID = "opencode";
const TIMEOUT_MS = Number(process.env.OC_BRIDGE_TIMEOUT_MS) || 150000;
const POLL_MS = 250;

const log = (...a) => console.log(`[oc-bridge]`, ...a);
const logErr = (...a) => console.error(`[oc-bridge]`, ...a);

// ── Service discovery / auth ──────────────────────────────────────────────────
let serviceUrl = (process.env.OPENCODE_SERVICE_URL || "").replace(/\/$/, "");

function servicePassword() {
  if (process.env.OPENCODE_SERVICE_PASSWORD) return process.env.OPENCODE_SERVICE_PASSWORD;
  try {
    const file = path.join(os.homedir(), ".config", "opencode", "service.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed?.password) return parsed.password;
  } catch (e) {
    logErr(`cannot read service.json: ${e.message}`);
  }
  return null;
}

const SERVICE_USER = process.env.OPENCODE_SERVICE_USER || "opencode";
const SERVICE_PASSWORD = servicePassword();

function findOpencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN;
  const bundled = path.join(os.homedir(), ".opencode", "bin", "opencode");
  if (fs.existsSync(bundled)) return bundled;
  return "opencode"; // rely on PATH
}
const OPENCODE_BIN = findOpencodeBin();

function discoverServiceUrl() {
  return new Promise((resolve) => {
    execFile(OPENCODE_BIN, ["service", "status"], { timeout: 8000 }, (err, stdout) => {
      const m = String(stdout || "").match(/https?:\/\/\S+/);
      if (m) {
        const url = m[0].replace(/\/$/, "");
        resolve(url);
      } else {
        resolve(null);
      }
      void err;
    });
  });
}

async function ensureServiceUrl() {
  if (serviceUrl) return serviceUrl;
  const discovered = await discoverServiceUrl();
  if (discovered) {
    serviceUrl = discovered;
    log(`discovered OpenCode service at ${serviceUrl}`);
  }
  return serviceUrl;
}

async function svc(method, apiPath, body = undefined, timeout = 30000) {
  const base = await ensureServiceUrl();
  if (!base) throw Object.assign(new Error("OpenCode service not found (is `opencode` running?)"), { status: 503 });

  const headers = { "Content-Type": "application/json" };
  if (SERVICE_PASSWORD) {
    headers["Authorization"] = "Basic " + Buffer.from(`${SERVICE_USER}:${SERVICE_PASSWORD}`).toString("base64");
  }

  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }).catch((e) => {
    serviceUrl = ""; // force rediscovery next time (service may have restarted on a new port)
    throw Object.assign(new Error(`OpenCode service unreachable: ${e.message}`), { status: 503 });
  });

  if (res.status === 401) {
    throw Object.assign(new Error("OpenCode service rejected credentials (service.json password?)"), { status: 503 });
  }
  return res;
}

async function svcJson(method, apiPath, body, timeout) {
  const res = await svc(method, apiPath, body, timeout);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  if (!res.ok) {
    const msg = json?.data?.message || json?.message || json?.error?.message || text?.slice(0, 300) || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status >= 500 ? 502 : res.status });
  }
  return json;
}

// ── Model catalogue ───────────────────────────────────────────────────────────
let modelCache = { at: 0, ids: [] };

async function listModelIds(force = false) {
  if (!force && Date.now() - modelCache.at < 60000 && modelCache.ids.length) return modelCache.ids;
  const json = await svcJson("GET", "/api/model", undefined, 15000);
  const rows = Array.isArray(json) ? json : (json?.data || []);
  const ids = rows
    .filter((m) => (m.providerID || PROVIDER_ID) === PROVIDER_ID)
    .map((m) => m.modelID || m.id)
    .filter(Boolean);
  modelCache = { at: Date.now(), ids };
  return ids;
}

function stripAlias(model) {
  return String(model || "").replace(/^oc\//, "");
}

// ── Prompt construction ───────────────────────────────────────────────────────
function flattenContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" || part?.type === "output_text") return part.text || "";
        if (part?.type === "image_url") return "[image]";
        return "";
      })
      .join("");
  }
  return String(content);
}

function buildPromptText(messages) {
  const list = Array.isArray(messages) && messages.length ? messages : [{ role: "user", content: "" }];
  const system = list
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => flattenContent(m.content))
    .filter(Boolean);
  const convo = list.filter((m) => m.role !== "system" && m.role !== "developer");
  const turns = convo.length ? convo : [{ role: "user", content: "" }];
  const last = turns[turns.length - 1];
  const history = turns.slice(0, -1);

  let text = "";
  if (system.length) text += `System instructions:\n${system.join("\n\n")}\n\n`;
  if (history.length) {
    text += "Conversation so far:\n";
    for (const m of history) text += `${m.role}: ${flattenContent(m.content)}\n`;
    text += "\n";
  }
  text += flattenContent(last.content);
  return text;
}

function extractAssistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === "text" || p?.type === "output_text")
      .map((p) => p.text || "")
      .join("");
  }
  return "";
}

// ── Core: run one chat completion through the local OpenCode client ──────────
async function runCompletion({ model, messages, timeoutMs = TIMEOUT_MS }) {
  const modelID = stripAlias(model);
  const ids = await listModelIds().catch(() => null);

  if (ids && ids.length && !ids.includes(modelID)) {
    const err = new Error(
      `Model "${modelID}" is not available in the local OpenCode client. ` +
      `Available: ${ids.join(", ")}`
    );
    err.status = 404;
    err.code = "model_not_found";
    throw err;
  }

  const text = buildPromptText(messages);
  const deadline = Date.now() + timeoutMs;
  let sessionId = null;

  try {
    const session = await svcJson("POST", "/api/session", {
      title: `9router: ${modelID}`,
      model: { providerID: PROVIDER_ID, id: modelID },
    }, 20000);
    sessionId = session?.data?.id || session?.id;
    if (!sessionId) throw Object.assign(new Error("OpenCode did not return a session id"), { status: 502 });

    await svcJson("POST", `/api/session/${sessionId}/prompt`, { text }, 30000);

    // Poll messages until the session goes idle (or we run out of time).
    let msgs = [];
    for (;;) {
      if (Date.now() > deadline) {
        throw Object.assign(new Error(`OpenCode did not finish within ${Math.round(timeoutMs / 1000)}s`), { status: 504 });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
      const json = await svcJson("GET", `/api/session/${sessionId}/message`, undefined, 20000);
      msgs = Array.isArray(json) ? json : (json?.data || []);
      if (msgs.some((m) => m.type === "idle")) break;
      // A pending permission request would hang forever — bail out early.
      const pending = await svcJson("GET", `/api/session/${sessionId}/permission`, undefined, 5000)
        .catch(() => ({ data: [] }));
      if ((pending?.data || []).length) {
        throw Object.assign(
          new Error("The model requested a tool permission; the bridge only serves plain text completions."),
          { status: 400 }
        );
      }
    }

    const idle = msgs.find((m) => m.type === "idle");
    const assistants = msgs
      .filter((m) => m.type === "assistant")
      .sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
    const reply = assistants[assistants.length - 1];
    const content = reply ? extractAssistantText(reply) : "";

    if (idle && idle.outcome && idle.outcome !== "succeeded" && !content) {
      throw Object.assign(new Error(`OpenCode run ${idle.outcome}`), { status: 502 });
    }
    if (!content) {
      throw Object.assign(new Error("OpenCode returned an empty completion"), { status: 502 });
    }

    const tokens = reply?.tokens || {};
    return {
      content,
      model: modelID,
      usage: {
        prompt_tokens: tokens.input ?? 0,
        completion_tokens: tokens.output ?? 0,
        total_tokens: (tokens.input ?? 0) + (tokens.output ?? 0),
      },
    };
  } finally {
    if (sessionId) {
      svc("DELETE", `/api/session/${sessionId}`, undefined, 8000).catch(() => {});
    }
  }
}

// ── OpenAI response shaping ───────────────────────────────────────────────────
function completionId() {
  return `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function writeJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function openAiError(res, status, message, type = "invalid_request_error", code = null) {
  writeJson(res, status, { error: { message, type, code, param: null } });
}

function chunkObject(id, created, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

async function sendStream(res, { id, created, model, content, usage }) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  send(chunkObject(id, created, model, { role: "assistant", content: "" }));

  // Emit in modest slices so dashboards animate instead of hanging until the end.
  const size = 48;
  for (let i = 0; i < content.length; i += size) {
    send(chunkObject(id, created, model, { content: content.slice(i, i + size) }));
    await new Promise((r) => setTimeout(r, 20));
    if (res.writableEnded) return;
  }

  send(chunkObject(id, created, model, {}, "stop"));
  res.write(`data: [DONE]\n\n`);
  res.end();
}

// ── HTTP server ───────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      const base = await ensureServiceUrl();
      return writeJson(res, 200, {
        status: "ok",
        service: base || null,
        authenticated: !!SERVICE_PASSWORD,
        timeoutMs: TIMEOUT_MS,
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const ids = await listModelIds();
      return writeJson(res, 200, {
        object: "list",
        data: ids.map((id) => ({
          id,
          object: "model",
          created: 1790000000,
          owned_by: PROVIDER_ID,
        })),
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const raw = await readBody(req);
      let body;
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return openAiError(res, 400, "Invalid JSON body");
      }

      const model = body.model;
      if (!model) return openAiError(res, 400, "Missing required parameter: 'model'", "invalid_request_error", "missing_model");

      const started = Date.now();
      let result;
      try {
        result = await runCompletion({
          model,
          messages: body.messages,
          timeoutMs: Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS,
        });
      } catch (e) {
        const status = e.status || 500;
        if (status === 404) return openAiError(res, 404, e.message, "invalid_request_error", e.code || "model_not_found");
        if (status === 504) return openAiError(res, 504, e.message, "timeout_error", "timeout");
        logErr(`completion failed for ${model}: ${e.message}`);
        return openAiError(res, status >= 400 && status < 600 ? status : 502, e.message, "server_error");
      }

      const id = completionId();
      const created = Math.floor(Date.now() / 1000);
      log(`✓ ${model} → ${result.content.length} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`);

      if (body.stream === true) {
        return await sendStream(res, { id, created, model: stripAlias(model), content: result.content, usage: result.usage });
      }

      return writeJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model: stripAlias(model),
        choices: [{
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason: "stop",
        }],
        usage: result.usage,
      });
    }

    return openAiError(res, 404, `Unknown route: ${route}`, "invalid_request_error", "unknown_route");
  } catch (e) {
    logErr(`error on ${route}: ${e.message}`);
    if (!res.headersSent) {
      return openAiError(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 502, e.message, "server_error");
    }
    res.end();
  }
});

server.listen(PORT, HOST, async () => {
  const base = await ensureServiceUrl();
  log(`listening on http://${HOST}:${PORT} (OpenCode service: ${base || "NOT FOUND"})`);
  if (!SERVICE_PASSWORD) logWarnNoPassword();
});

function logWarnNoPassword() {
  logErr(`WARNING: no service password found — OpenCode API calls will return 401.`);
}

server.on("error", (e) => {
  logErr(`server error: ${e.message}`);
  process.exit(1);
});
