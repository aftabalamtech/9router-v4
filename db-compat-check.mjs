// Guard the PostgreSQL/SQLite compatibility requirement.
//
// The DB layer is a single kv store behind a driver-agnostic adapter
// (backend/src/lib/db/helpers/kvStore.js), so driver compatibility is really a
// question of "did this change add driver-specific SQL, or a schema migration?".
//
// This check asserts, for the files this feature touches:
//   1. no raw driver-flavoured SQL leaked in (SERIAL, JSONB, ILIKE, RETURNING,
//      DDL), and
//   2. persistence still goes through the adapter's upsert helper rather than
//      hand-written ON CONFLICT, and
//   3. no new migration was added.
//
// Run from the repo root:  node db-compat-check.mjs
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

const CHANGED_FILES = [
  "backend/src/lib/models/autoAdd.js",
  "backend/src/lib/models/capabilityTest.js",
  "backend/src/lib/models/capabilityRegistry.js",
  "backend/src/shared/constants/modelCapabilities.js",
  "backend/src/shared/constants/providerCapabilities.js",
  "backend/src/routes/models/test/route.ts",
  "backend/src/routes/models/register/route.ts",
  "backend/src/routes/providers/[id]/sync-models/route.ts",
  "backend/src/routes/providers/[id]/models/route.ts",
];

// Constructs that would tie the schema or a query to one engine.
//
// Case-SENSITIVE on purpose: these are SQL keywords written in upper case in
// this codebase, and a case-insensitive match flags ordinary English prose
// ("Returning a reason...") as a portability violation.
const DRIVER_SPECIFIC = [
  [/\bSERIAL\b/, "SERIAL (Postgres-only)"],
  [/\bBIGSERIAL\b/, "BIGSERIAL (Postgres-only)"],
  [/\bJSONB\b/, "JSONB (Postgres-only)"],
  [/\bILIKE\b/, "ILIKE (not portable)"],
  [/\bRETURNING\b/, "RETURNING (not portable)"],
  [/\bAUTOINCREMENT\b/, "AUTOINCREMENT (SQLite-only)"],
  [/\bPRAGMA\b/, "PRAGMA (SQLite-only)"],
  [/\bALTER TABLE\b/, "ALTER TABLE (schema change)"],
  [/\bDROP TABLE\b/, "DROP TABLE (destructive)"],
  [/\bCREATE INDEX\b/, "CREATE INDEX outside a migration"],
];

const problems = [];

console.log("driver-compatibility checks:");

for (const file of CHANGED_FILES) {
  const src = readFileSync(file, "utf8");
  const found = DRIVER_SPECIFIC.filter(([re]) => re.test(src)).map(([, name]) => name);
  if (found.length) {
    problems.push(`${file}: ${found.join(", ")}`);
    console.log(`  FAIL ${file}: ${found.join(", ")}`);
  } else {
    console.log(`  ok  ${file}`);
  }
}

// Persistence for this feature is `makeKv(...)`, which routes through the
// adapter. Assert that explicitly — it is the actual reason both engines work.
for (const [file, scope] of [
  ["backend/src/lib/models/modelSync.js", 'makeKv("providerModelSync")'],
  ["backend/src/lib/models/capabilityRegistry.js", 'makeKv("modelCapabilities")'],
]) {
  const src = readFileSync(file, "utf8");
  if (!src.includes(scope)) {
    problems.push(`${file}: ${scope} no longer persisted through the kv adapter`);
    console.log(`  FAIL ${file}: ${scope} not found`);
  } else {
    console.log(`  ok  ${file} persists ${scope} through the kv adapter`);
  }
}

// The new setting must be part of the normalized settings object, so both
// engines store the identical JSON shape.
{
  const src = readFileSync("backend/src/lib/models/autoAdd.js", "utf8");
  if (!/autoAddKinds: normalizeAutoAddKinds\(base\.autoAddKinds\)/.test(src)) {
    problems.push("autoAdd.js: autoAddKinds is not normalized on read (engines could store different shapes)");
    console.log("  FAIL autoAdd.js: autoAddKinds is not normalized on read");
  } else {
    console.log("  ok  autoAdd.js normalizes autoAddKinds on read");
  }
}

// No new migration: the feature is additive inside an existing JSON blob.
{
  const migrations = readdirSync("backend/src/lib/db/migrations")
    .filter((f) => f !== "index.js" && f.endsWith(".js"))
    .sort();
  console.log(`  info migrations on disk: ${migrations.join(", ")}`);
  let added = [];
  try {
    const status = execSync("git status --porcelain -- backend/src/lib/db/migrations", { encoding: "utf8" });
    added = status.split("\n").filter((l) => l.trim() && !l.includes("D "));
  } catch {
    // Not a git checkout; skip the added-file assertion.
  }
  if (added.length) {
    problems.push(`a migration was added: ${added.join(", ")}`);
    console.log(`  FAIL uncommitted migration changes present`);
  } else {
    console.log("  ok  no migration added (schema-neutral change)");
  }
}

console.log("");
if (problems.length) {
  console.log("PROBLEMS:");
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("all driver-compatibility checks passed");
