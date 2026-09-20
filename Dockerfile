# syntax=docker/dockerfile:1

# ─── Production Dockerfile for 9Router V3 ──────────────────────────────────
# Multi-stage build: dependencies → build → minimal production runner.
# Serves BOTH the API and the built dashboard from one Node process
# (backend serves frontend/dist). Needs no build tools: better-sqlite3
# ships musl prebuilds for Node 22, and the DB falls back to node:sqlite.
#
# Build:  docker build -t 9router-v3 .
# Run:    docker run --env-file .env -p 3001:3001 -v 9router-data:/data 9router-v3

FROM node:22-alpine AS base
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY backend/open-sse/package.json backend/open-sse/package.json
COPY backend/open-sse ./backend/open-sse
RUN npm ci

FROM base AS builder
WORKDIR /app
COPY . .
RUN npm run build --workspace=9router-frontend
RUN npm run build --workspace=9router-backend

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3001

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY backend/bin backend/bin
COPY backend/open-sse/package.json backend/open-sse/package.json
COPY backend/open-sse ./backend/open-sse
RUN npm ci --omit=dev

COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/frontend/dist ./frontend/dist
# Optional automation and MITM routes launch runtime scripts from this tree.
# Generated browser profiles are excluded by .dockerignore.
COPY backend/src ./backend/src

# Run as non-root. /data is the SQLite volume mount point (override at runtime).
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && mkdir -p /data && chown -R appuser:appgroup /app /data
USER appuser

# NOTE: no VOLUME instruction on purpose — Railway rejects it.
# Mount /data via compose volumes / platform volumes instead.
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# Must stay an npm workspace command: backend's alias-loader resolves @/
# imports relative to the backend working directory.
CMD ["npm", "run", "start", "--workspace=9router-backend"]
