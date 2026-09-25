import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authMiddleware } from "./middleware/auth.js";
import { buildAutoRouter } from "./autoRouter.js";

const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5177";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, "../../frontend/dist");

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, callback) => {
    callback(null, origin || true);
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
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: "3.0.0", ts: Date.now() });
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
    console.log(`   Frontend origin: ${FRONTEND_ORIGIN}`);
    console.log(`   Environment: ${process.env.NODE_ENV || "development"}\n`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

export { app };
