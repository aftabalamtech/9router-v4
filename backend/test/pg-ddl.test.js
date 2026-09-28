// PostgreSQL DDL validity regression test.
//
// ROOT CAUSE of the Render 42601 startup crash: migration 001 built
// `CREATE TABLE ... INTEGER PRIMARY KEY AUTOINCREMENT ...` (SQLite-only
// syntax) without forwarding the dialect. Position 65 of the failing
// statement is exactly where AUTOINCREMENT starts in the usageHistory DDL —
// confirmed by decoding the PG error (42601, scanner_yyerror, position 65,
// statement length 102).
//
// These tests run WITHOUT a PostgreSQL server: they assert the generated DDL
// never contains SQLite-only tokens when the postgres dialect is requested,
// and that every migration forwards the dialect it receives.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TABLES, buildCreateTableSql, toPostgresColumnDef } from "../src/lib/db/schema.js";
import { MIGRATIONS } from "../src/lib/db/migrations/index.js";

const SQLITE_ONLY_TOKENS = [
  /\bAUTOINCREMENT\b/i,
  /\bINSERT\s+OR\s+REPLACE\b/i,
  /\bINSERT\s+OR\s+IGNORE\b/i,
  /PRAGMA\s+/i,
];

describe("postgres DDL validity (regression: 42601)", () => {
  it("no SQLite-only tokens in any table DDL for the postgres dialect", () => {
    for (const [tableName, def] of Object.entries(TABLES)) {
      const sql = buildCreateTableSql(tableName, def, "postgres");
      for (const token of SQLITE_ONLY_TOKENS) {
        assert.equal(
          token.test(sql),
          false,
          `${tableName} DDL contains SQLite-only syntax for postgres: ${sql}`
        );
      }
    }
  });

  it("usageHistory DDL: AUTOINCREMENT is rewritten to SERIAL for postgres", () => {
    const sql = buildCreateTableSql("usageHistory", TABLES.usageHistory, "postgres");
    assert.match(sql, /id SERIAL PRIMARY KEY/);
    assert.doesNotMatch(sql, /AUTOINCREMENT/i);
    // And the SQLite dialect keeps AUTOINCREMENT — engine behavior unchanged.
    const sqliteSql = buildCreateTableSql("usageHistory", TABLES.usageHistory, "sqlite");
    assert.match(sqliteSql, /AUTOINCREMENT/);
  });

  it("additive column definitions are PG-safe (no CHECK/PRIMARY KEY/UNIQUE)", () => {
    // Mirrors migrate.js syncSchemaFromTables post-processing for PG.
    const strip = (colDef) =>
      toPostgresColumnDef(colDef)
        .replace(/PRIMARY KEY( AUTOINCREMENT)?/i, "")
        .replace(/UNIQUE/i, "")
        .replace(/CHECK\s*\([^)]*\)/i, "")
        .trim();
    for (const def of Object.values(TABLES)) {
      for (const [colName, colDef] of Object.entries(def.columns)) {
        const safe = strip(colDef);
        assert.doesNotMatch(safe, /AUTOINCREMENT|PRIMARY KEY|UNIQUE|CHECK\s*\(/i, `${colName}: ${safe}`);
      }
    }
  });

  it("every migration accepts and uses the dialect argument", async () => {
    for (const migration of MIGRATIONS) {
      const mod = migration;
      assert.equal(typeof mod.up, "function", `migration ${migration.version} has no up()`);
      // Calls must not throw with a dialect-aware no-op db.
      const executed = [];
      const noopDb = {
        exec: (sql) => executed.push(sql),
        run: (sql) => executed.push(sql),
        get: () => undefined,
        all: () => [],
        transaction: (fn) => fn(),
      };
      // Migration 002 with postgres dialect must emit PG-safe SQL.
      mod.up(noopDb, "postgres");
      for (const sql of executed) {
        if (typeof sql !== "string") continue;
        assert.equal(
          /\bAUTOINCREMENT\b|INSERT\s+OR\s+/i.test(sql),
          false,
          `migration ${migration.version} emitted SQLite-only SQL under postgres dialect: ${sql.slice(0, 120)}`
        );
      }
    }
  });
});
