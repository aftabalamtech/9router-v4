# Custom Provider (OpenAI/Anthropic-Compatible) Architecture

Notes for the Graphify knowledge graph. Companion to the existing "Model Sync
Jobs" and "Model Sync Panel UI" communities. Everything here is verified
against the code in this repository.

## What a custom provider IS

A custom provider is a **row in `providerNodes`**, not an entry in the static
`AI_PROVIDERS` registry. Its `id` is the provider id everywhere in the system
and is generated as:

| node `type`                 | generated `id`                              |
|-----------------------------|---------------------------------------------|
| `openai-compatible`         | `openai-compatible-<apiType>-<uuid>`        |
| `anthropic-compatible`      | `anthropic-compatible-<uuid>`               |
| `custom-embedding`          | `custom-embedding-<uuid>`                   |

`apiType` is `chat` or `responses` and is **encoded in the id** for
OpenAI-compatible nodes — code that needs it (the executor's URL builder) reads
it from the id, not from a join.

Type detection is by **id prefix only** (`isOpenAICompatibleProvider` and
friends). The two `providers.js` files — `backend/src/shared/constants/` and
`frontend/src/shared/constants/` — are duplicated, not shared, and must stay in
sync.

## Ownership relationships

```
providerNodes (the provider: name, prefix, apiType, baseUrl, type)
   │  id  = provider id
   ├──► providerConnections (N per node now)   provider = node.id
   │       per-connection: name, apiKey, priority, isActive, testStatus,
   │       providerSpecificData { prefix, apiType?, baseUrl, nodeName, proxy… }
   ├──► syncedModels kv  key = "<nodeId>|<modelId>"      (discovered catalog)
   ├──► modelAliases kv   key = alias      value = "<nodeId>/<modelId>"  (added)
   ├──► modelTestResults  key = "<nodeId>/<modelId>"     (last test)
   └──► disabledModels kv key = nodeId      value = [modelId]  (disabled)
```

The node id doubles as the **storage alias**. `getProviderAlias(nodeId)`
returns the node id unchanged because `AI_PROVIDERS[nodeId]` is undefined — many
call sites depend on that `getProviderAlias(k) || k` idiom.

## Naming (the "Xkiro" fix)

A custom provider's display name is the **node's `name`**. It is never the
generic type label and never the opaque node id. Single resolver:

- `frontend/src/shared/utils/providerNaming.js` → `getProviderDisplayName()`
  Precedence: explicit override → node record → connection
  `providerSpecificData.nodeName` → connection name (if it isn't the node id) →
  generic type label → "Custom Provider".
- `GET /api/providers` returns `providerName` (the node name) on every custom
  connection, so the Playground and selectors need only one extra field.
- `owned_by` in `GET /v1/models` is the node name; the **routing** id/alias
  still uses the node id or its `prefix`.

Model naming rule: the **upstream model id is never rewritten for display**.
`name` is display-only; the router forwards `id` unchanged
(`getModelUpstreamId` returns the id verbatim for custom providers because they
have no `PROVIDER_MODELS` entry).

## Endpoint construction

One normalizer, `backend/src/lib/net/compatibleUrl.js`:

- `normalizeCompatibleBaseUrl` — trims, strips trailing slashes, strips a pasted
  `/chat/completions` | `/models` | `/messages` | `/responses` | `/embeddings`
  suffix, removes embedded userinfo, upgrades a schemeless host to https.
- `buildCompatibleChatUrl` / `buildCompatibleModelsUrl` /
  `buildCompatibleEmbeddingsUrl`.
- It never appends `/v1` — self-hosted gateways legitimately live at the root.

This replaces three divergent copies that previously produced doubled paths
(`.../chat/completions/chat/completions`, `.../models/models`). Consumers:
`executors/base.js`, `executors/default.js`, `services/provider.js`,
`providers/[id]/models`, `providers/[id]/test/testUtils`, `provider-nodes`
create/update, `v1/models`.

The normalizer is **idempotent** — a value already normalized is unchanged — so
it is safe to apply at write time (node create/update) *and* at request time.

## Response bodies are read exactly once

`backend/src/lib/net/httpBody.js`:

- `readJsonBody` / `readResponseOnce` read the body as **text** and then parse.
- `parseErrorPayload` builds an actionable message from an already-read body.

This is the fix for `Body is unusable: Body has already been read`, caused by
`try { res.json() } catch { res.text() }` — `.json()` consumes the stream, then
`.text()` inside the catch throws, masking the real upstream error. Every
compatible-provider and OAuth path now uses the single-read helpers.

Rule for this codebase: **never call both `.json()` and `.text()` on the same
response**; never branch on `res.ok` to decide which one to call.

## Connections

Custom providers support **multiple connections**, like built-in providers.
Node fields (`prefix`, `apiType`, `baseUrl`, `nodeName`) are merged *under* the
caller's own `providerSpecificData`, so a connection may override `baseUrl`
(multi-endpoint setups) and the node rename path can no longer clobber a
connection's proxy binding or capabilities.

Connections dedup on `(authType, name)` in
`connectionsRepo.createProviderConnection`, so a duplicate name would silently
UPDATE the existing row and **replace its API key**. Both the single-add route
(`uniqueConnectionName`) and the bulk planner disambiguate ("Main", "Main 2").

API keys are stored in the connection's `data` JSON column and are never
returned to the browser (`GET /api/providers` nulls them). They are **not
encrypted at rest** — the UI no longer claims otherwise.

## Bulk import

`POST /api/providers/bulk` — validates the whole batch, then writes it through
the normal `createProviderConnection` path.

- `backend/src/lib/models/bulkConnections.js` — pure planner (no DB, no fetch):
  validates each entry, detects duplicates against existing keys and within the
  batch, reserves unique names.
- `frontend/src/shared/utils/bulkKeys.js` — pure client parser for the review
  step; collapses in-paste duplicates and redacts credential-shaped text.
- API keys never appear in a response, a log line, or an error string. Model
  tests are never triggered by a bulk import.

## Model discovery panel

Sections, in order: Provider Configuration → Connections → Sync & discovery
(discovered catalog) → Added models → Disabled models.

- **Discovered** = synced catalog entries that are NOT added and NOT built-in.
  Identified by `storageAlias + upstream model id`.
- **Added** = alias record or built-in model. Rendered by the existing
  per-provider model list. A model never appears in both.
- **Disabled** = the shared `disabledModels` store, rendered in its own section
  with an Enable action.

Sync safety (`modelSync.runSyncJob`): if **every** connection fails or the
upstream returns an empty catalog, the stored catalog is left untouched and the
job reports `preserved` instead of marking everything stale. `persistDiscovered`
is idempotent and merges rather than replaces, and revives a model that
reappears upstream.

Auto-Add policies (`backend/src/lib/models/autoAdd.js`, mirrored in
`frontend/src/shared/utils/discoveredModels.js`) — four offered, all distinct:
`working-only`, `working-disable-failed`, `working-untested`, `all`. The
retired id `working-ignore-failed` is still accepted on read and normalized to
`working-only` so existing settings keep working. Auto-Add runs once per finished
sync from the latest persisted test results; it never force-tests a catalog and
never re-enables a disabled model.

## Database engine notes (SQLite + PostgreSQL)

Verified state of `backend/src/lib/db/`:

- **One schema, two engines.** `schema.js` declares `TABLES` with SQLite types;
  `toPostgresColumnDef()` rewrites `INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL
  PRIMARY KEY` and `REAL → DOUBLE PRECISION`. `ON CONFLICT ... DO UPDATE` is
  portable; the `?` → `$n` placeholder rewrite lives in
  `adapters/postgresAdapter.js#convertPlaceholders` (a tokenizer that skips
  strings, quoted identifiers, comments and dollar-quoted bodies — pinned by
  `backend/test/pg-placeholder-test.js`).
- **Migrations run on BOTH engines** (this was the core V4 fix: the versioned
  chain previously only ran on the SQLite path, so PostgreSQL deployments
  never stamped `_meta.schemaVersion` and never got additive column sync).
  `migrate.js#runMigrationOnce(adapter, { dialect })` drives the same chain
  for both; migration `002-composite-unique` has per-dialect rebuild SQL.
  `syncSchemaFromTables` uses `PRAGMA table_info` on SQLite and
  `information_schema.columns` on PostgreSQL.
- **Legacy JSON import is SQLite-only by design.** A fresh PostgreSQL DB never
  auto-imports whatever `db.json` happens to sit in the container's DATA_DIR —
  cross-DB migration is explicit via Settings → Database export/import.
- **No silent fallback.** `DATABASE_URL` set but unreachable → the process
  fails fast with an actionable message; it never boots on an empty SQLite
  file (that split-brain is what previously "lost" providers).
- **Diagnostics:** `lib/db/diagnostics.js#getDbDiagnostics()` returns driver,
  connected, schemaVersion, pending-migration count and missing tables.
  Surfaced (non-sensitive only) on `GET /api/health` as a `database` block,
  cached for 15s. No URLs, hosts, credentials or row data.
- **REGRESSION RULE (learned the hard way):** `/api/health` must NEVER await
  DB init. pg's `Pool.connect()` has no default timeout, so awaiting it on an
  unreachable DATABASE_URL hangs the probe → Render fails health checks →
  Cloudflare serves 503. The endpoint now races diagnostics against a 2s
  timeout (reporting "initializing"), and the pg adapter enforces a 10s
  connect timeout (`PG_CONNECT_TIMEOUT_MS` overridable) so a dead DATABASE_URL
  errors loudly within seconds. DB init itself runs in the background at boot
  (`initDb()` after route mount) — boot speed and health probes never depend
  on database reachability. Verified by `backend/test/prod-boot-check.manual.mjs`.
- **Transactions:** PostgreSQL uses one client per transaction with
  AsyncLocalStorage + SAVEPOINT nesting; a failing ROLLBACK no longer masks
  the original error. SQLite wraps everything in a global promise queue
  (`asyncAdapter.js`) — no yield between read and write inside `db.transaction`.
- **Known limitation:** `sql.js` (the pure-JS SQLite fallback) persists by
  exporting the whole DB with a 100ms debounce — a hard kill can lose the last
  write. better-sqlite3 / node:sqlite / bun:sqlite are WAL-backed and safe.

### Render "providers disappear" — root-cause summary

The deployment factors that produce the reported symptom, in likelihood order:
1. No persistent disk attached + `DATA_DIR=/data` default → SQLite file lives
   in the container layer and is wiped on every deploy (dataDir.js falls back
   to `~/.9router-v3` only when /data is unwritable — still ephemeral).
2. `DATABASE_URL` set with a stale/typo'd connection string while a fallback
   (pre-fix behavior or external code path) landed the app on empty SQLite.
3. Legacy JSON import markers: `.migrated-from-json` lives under DATA_DIR —
   rebuilt containers re-run legacy import from an ephemeral db.json.

All three are addressed: fail-fast on bad DATABASE_URL, migrations on PG,
legacy import disabled for PG, and `/api/health` diagnostics to identify the
active engine in production.

### Render 42601 startup crash (post-mortem)

Migration `001-initial.js` called `buildCreateTableSql(name, def)` WITHOUT the
dialect, emitting SQLite-only `INTEGER PRIMARY KEY AUTOINCREMENT` against
PostgreSQL — error 42601 (syntax_error, `scanner_yyerror`), position 65 of the
`usageHistory` DDL being exactly where `AUTOINCREMENT` starts. Rule: **every
migration `up(db, dialect)` must forward the dialect into every SQL builder
it uses.** Pinned by `backend/test/pg-ddl.test.js`, which scans ALL table DDL
and all migration output under the postgres dialect for SQLite-only tokens
(AUTOINCREMENT, INSERT OR REPLACE/IGNORE, PRAGMA).

Also: `DATA_DIR` fallback warnings are now actionable — they state whether
data is safe (DATABASE_URL set → PostgreSQL, unaffected) or at risk (SQLite
on an ephemeral container filesystem).

## Related communities

- Model Sync Jobs (`backend/src/lib/models/modelSync.js`)
- Model Sync Panel UI (`frontend/src/pages/providers/[id]/ModelSyncPanel.jsx`)
- KV Store And Model Disabling (`disabledModelsRepo.js`)
- Database Adapter And Meta (`backend/src/lib/db/`)
- Custom Models And Aliases (`aliasRepo.js`)
