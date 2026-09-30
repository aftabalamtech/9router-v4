import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authMiddleware } from "./middleware/auth.js";
import { buildAutoRouter } from "./autoRouter.js";
import { getDbDiagnostics } from "./lib/db/diagnostics.js";
import { initDb } from "./lib/db/index.js";
import { DATA_DIR } from "./lib/dataDir.js";

const PORT = Number(process.env.PORT) || 3001;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, "../../frontend/dist");

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// Same-origin production traffic and the dev Vite proxy both send no CORS
// preflight, so reflect-back stays the default. When CORS_ORIGINS is set the
// allowlist is enforced instead of reflection, which is the only opt-in change
// to cross-origin behaviour.
const configuredOrigins = new Set(
  (process.env.CORS_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean)
);
app.use(cors({
  origin(origin, callback) {
    if (configuredOrigins.size === 0) return callback(null, origin || true);
    if (!origin || configuredOrigins.has(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-9r-cli-token"],
}));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: "128mb" }));
app.use(express.urlencoded({ extended: true, limit: "128mb" }));

// ─── Health Check (no auth) ────────────────────────────────────────────────────
// Includes NON-SENSITIVE database diagnostics: active engine, connection
// status, schema/migration version and whether required tables exist. Never
// exposes URLs, hosts, credentials or row data — safe for orchestrator probes.
//
// REGRESSION GUARD: this endpoint must NEVER block on database init. The
// previous version awaited DB diagnostics directly; with an unreachable
// DATABASE_URL (pg has no default connect timeout) the probe hung forever,
// Render failed the health checks and the service 503'd. Now diagnostics race
// a short timeout: the HTTP server always answers quickly, and the database
// block honestly reports "initializing"/"unavailable" instead of masking it.
const DIAGNOSTICS_TIMEOUT_MS = 2_000;
let dbDiagnosticsCache: { at: number; value: Record<string, unknown> } | null = null;

async function getDiagnosticsForHealth(): Promise<Record<string, unknown>> {
  if (dbDiagnosticsCache && Date.now() - dbDiagnosticsCache.at < 15_000) {
    return dbDiagnosticsCache.value;
  }
  const value = (await Promise.race([
    getDbDiagnostics(),
    new Promise((resolve) =>
      setTimeout(() => resolve({ status: "initializing" }), DIAGNOSTICS_TIMEOUT_MS)
    ),
  ])) as Record<string, unknown>;
  // Cache only completed results — an "initializing" placeholder must not
  // stick around once the real answer is available.
  if (value.status !== "initializing") {
    dbDiagnosticsCache = { at: Date.now(), value };
  }
  return value;
}

app.get("/api/health", async (_req, res) => {
  let database: Record<string, unknown> | undefined;
  try {
    database = await getDiagnosticsForHealth();
  } catch {
    database = { status: "unavailable" };
  }
  // Keep 200 for platform probes: this process is listening and routes are
  // mounted, and readiness of the DB is reported in the payload. Returning 503
  // here previously made Render treat a booting service as failed.
  res.json({
    status: "ok",
    version: "3.0.0",
    ts: Date.now(),
    database,
  });
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────
// Authentication only applies to API/proxy traffic. Applying it globally would
// prevent the login page and SPA assets from loading when login is required.
app.use((req, res, next) => {
  if (
    req.path === "/api" ||
    req.path.startsWith("/api/") ||
    req.path === "/v1" ||
    req.path.startsWith("/v1/") ||
    req.path === "/v1beta" ||
    req.path.startsWith("/v1beta/")
  ) {
    return authMiddleware(req, res, next);
  }
  return next();
});

// ─── Auto-mount all routes ────────────────────────────────────────────────────
async function start() {
  const apiRouter = await buildAutoRouter();
  app.use("/api", (req, res, next) => {
    console.log("API request:", req.method, req.url, req.originalUrl);
    apiRouter(req, res, next);
  });

  // Initialize the database in the background: boot and health checks stay
  // fast, while a broken DATABASE_URL surfaces in the logs immediately
  // (with the pg connect timeout it errors within seconds, never hangs).
  initDb()
    .then(() => console.log("[DB] initialized"))
    .catch((err: Error) => console.error("[DB] init failed:", err?.message || err));

  // LLM proxy remaps: /v1/* → /api/v1/*
  app.use("/v1", (req, res, next) => {
    req.url = "/v1" + req.url;
    apiRouter(req, res, next);
  });
  app.use("/v1beta", (req, res, next) => {
    req.url = "/v1beta" + req.url;
    apiRouter(req, res, next);
  });

  app.use(["/api", "/v1", "/v1beta"], (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // Serve the production SPA from the same origin as the API.
  // Vite emits content-hashed filenames under /assets, so those are immutable
  // and safe to cache for a year. Without this express sends `max-age=0`, which
  // forces the 272 KB icon font plus every JS chunk to be re-downloaded on
  // every single page load. The font file and index.html are NOT hashed, so they
  // stay revalidated to keep a redeploy from serving a stale shell.
  app.use(
    express.static(FRONTEND_DIST, {
      index: false,
      redirect: false,
      setHeaders(res, filePath) {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else if (filePath.endsWith(".woff2") || filePath.endsWith(".woff")) {
          res.setHeader("Cache-Control", "public, max-age=604800");
        } else {
          res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        }
      },
    })
  );
  app.use((req, res, next) => {
    // Accept HEAD as well as GET so cache/probe tooling can inspect the shell.
    if ((req.method === "GET" || req.method === "HEAD") && req.accepts("html")) {
      res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
      return res.sendFile(path.join(FRONTEND_DIST, "index.html"), (err) => {
        if (err && !res.headersSent) return next();
      });
    }
    return next();
  });

  // ─── 404 Fallback ──────────────────────────────────────────────────────────
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));

  // ─── Error Handler ─────────────────────────────────────────────────────────
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[server] unhandled error:", err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 9Router V3 Backend running on http://localhost:${PORT}`);
    console.log(`   Data dir: ${DATA_DIR}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export { app };
