// PostgreSQL adapter placeholder-conversion tests.
//
// convertPlaceholders rewrites sqlite-style `?` parameters into PostgreSQL
// `$n` placeholders. A naive string replace corrupts any query that contains
// a literal `?` inside a string literal, a quoted identifier, a comment or a
// dollar-quoted body — data corruption class bug, so the tokenizer is pinned
// here. No database connection required: the function is pure.
//
// Run: npm test   (node --test, no extra dependencies)
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { convertPlaceholders } from "../src/lib/db/adapters/postgresAdapter.js";

describe("pg placeholder conversion", () => {
  it("converts simple sequential placeholders", () => {
    assert.equal(
      convertPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"),
      "SELECT * FROM t WHERE a = $1 AND b = $2"
    );
  });

  it("does NOT convert a ? inside a string literal", () => {
    assert.equal(
      convertPlaceholders(`INSERT INTO kv(scope, key, value) VALUES('a?b', ?, ?)`),
      `INSERT INTO kv(scope, key, value) VALUES('a?b', $1, $2)`
    );
  });

  it("does NOT convert a ? inside a double-quoted identifier", () => {
    assert.equal(
      convertPlaceholders(`SELECT "col?name" FROM t WHERE a = ?`),
      `SELECT "col?name" FROM t WHERE a = $1`
    );
  });

  it("does NOT convert a ? inside a line comment", () => {
    assert.equal(
      convertPlaceholders("SELECT 1 -- filter: a=?\nWHERE a = ?"),
      "SELECT 1 -- filter: a=?\nWHERE a = $1"
    );
  });

  it("does NOT convert a ? inside a block comment", () => {
    assert.equal(
      convertPlaceholders("SELECT /* a ? b */ ?"),
      "SELECT /* a ? b */ $1"
    );
  });

  it("does NOT convert a ? inside a dollar-quoted body", () => {
    assert.equal(
      convertPlaceholders("SELECT $$what?ever$$, ?"),
      "SELECT $$what?ever$$, $1"
    );
  });

  it("preserves escaped single quotes inside strings", () => {
    assert.equal(
      convertPlaceholders(`INSERT INTO t VALUES('it''s ? here', ?)`),
      `INSERT INTO t VALUES('it''s ? here', $1)`
    );
  });

  it("handles dollar-tagged bodies ($fn$ ... $fn$)", () => {
    assert.equal(
      convertPlaceholders("SELECT $tag$ ? $tag$, ?"),
      "SELECT $tag$ ? $tag$, $1"
    );
  });

  it("leaves queries without placeholders unchanged", () => {
    const sql = "SELECT * FROM providerNodes WHERE id = 'x'";
    assert.equal(convertPlaceholders(sql), sql);
  });

  it("counts correctly across mixed contexts", () => {
    const out = convertPlaceholders(
      `-- q? \nUPDATE kv SET value = ? WHERE scope = 's?c' AND key = ? /* x? */`
    );
    assert.equal(out, `-- q? \nUPDATE kv SET value = $1 WHERE scope = 's?c' AND key = $2 /* x? */`);
  });
});
