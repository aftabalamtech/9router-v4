// Database diagnostics — safe, read-only introspection of the active DB engine.
//
// Every field returned here is intentionally NON-SENSITIVE: engine name,
// connection status, schema version, and whether required tables exist.
// No URLs, no hostnames, no credentials, no row data.
//
// Consumed by GET /api/health (unauthenticated by design, like the rest of the
// health payload) and usable from an authenticated settings page if needed.

import { TABLES } from "../db/schema.js";
import { MIGRATIONS, latestVersion } from "../db/migrations/index.js";
import { getMeta } from "../db/helpers/metaStore.js";

export async function getDbDiagnostics() {
  const diagnostics = {
    driver: "unknown",       // which engine is active ("better-sqlite3", "postgresql", ...)
    connected: false,        // can we talk to it right now?
    schemaVersion: 0,        // applied versioned-migration stamp (_meta.schemaVersion)
    migrations: {
      latest: latestVersion(),
      pending: 0,            // how many versioned migrations have NOT run yet
    },
    tables: { expected: 0, present: 0, missing: [] },
    init: { ok: false },
  };

  try {
    const { getAdapter } = await import("../db/driver.js");
    const db = await getAdapter();
    diagnostics.driver = db.driver || "unknown";
    diagnostics.connected = true;

    // Schema version: _meta is created by the migration runner, so a missing
    // table means migrations have not run at all — treat as version 0.
    try {
      const row = await db.get(`SELECT value FROM _meta WHERE key = 'schemaVersion'`);
      diagnostics.schemaVersion = row ? (parseInt(row.value, 10) || 0) : 0;
    } catch {
      diagnostics.schemaVersion = 0;
    }
    diagnostics.migrations.pending = MIGRATIONS.filter((m) => m.version > diagnostics.schemaVersion).length;

    // Required tables present? (engine-agnostic introspection)
    const expected = Object.keys(TABLES);
    diagnostics.tables.expected = expected.length;
    let presentNames = new Set();
    if (db.driver === "postgresql") {
      const rows = await db.all(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()`
      );
      presentNames = new Set(rows.map((r) => String(r.table_name).toLowerCase()));
    } else {
      const rows = await db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`);
      presentNames = new Set(rows.map((r) => String(r.name).toLowerCase()));
    }
    const missing = expected.filter((t) => !presentNames.has(t.toLowerCase()));
    diagnostics.tables.present = expected.length - missing.length;
    diagnostics.tables.missing = missing;

    diagnostics.init.ok = missing.length === 0 && diagnostics.migrations.pending === 0;
  } catch (error) {
    diagnostics.connected = false;
    diagnostics.init.ok = false;
    // The error message can embed host/connection details — never surface it.
    diagnostics.error = "Database initialization failed. Check server logs.";
    console.error("[DB diagnostics]", error?.message || error);
  }

  return diagnostics;
}
