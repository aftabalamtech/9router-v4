// Initial schema bootstrap. For fresh DB this creates all tables/indexes.
// For existing DB at version 0 (legacy unstamped), it's idempotent (IF NOT EXISTS).
//
// The dialect MUST be forwarded to buildCreateTableSql: the SQLite-typed
// column definitions (e.g. `INTEGER PRIMARY KEY AUTOINCREMENT`) are invalid
// PostgreSQL syntax (PG 42601 at the AUTOINCREMENT keyword). This was the
// Render startup crash: migration 001 ran SQLite SQL against PostgreSQL.
import { TABLES, buildCreateTableSql } from "../schema.js";

export default {
  version: 1,
  name: "initial",
  // async up: the adapter contract is async (PostgreSQL), so db.exec must be awaited.
  async up(db, dialect = "sqlite") {
    for (const [name, def] of Object.entries(TABLES)) {
      await db.exec(buildCreateTableSql(name, def, dialect));
      for (const idx of def.indexes || []) await db.exec(idx);
    }
  },
};
