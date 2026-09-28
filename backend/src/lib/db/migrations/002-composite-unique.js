// Recreate codebuddyAccounts table to drop the single-column UNIQUE(email)
// and replace it with composite UNIQUE(email, provider).
//
// Table rebuilds are engine-specific: SQLite uses `ALTER TABLE ... RENAME`
// with `INSERT OR IGNORE`, PostgreSQL needs FK-safe handling and
// `ON CONFLICT DO NOTHING`. The migration receives the dialect from
// runVersionedMigrations() so both engines reach schemaVersion 2.
export default {
  version: 2,
  name: "composite-unique-codebuddy-accounts",
  up(db, dialect = "sqlite") {
    const isPostgres = dialect === "postgres";

    const COLUMNS = `id, email, password, profileDir, ammailAlias, signupMethod,
      apiKey, apiKeyStatus, lastError, lastRunAt, createdAt, provider, canvaEnrolled`;

    if (isPostgres) {
      // 1. Rename existing table (+ its PK/index move with it in PG)
      db.exec("ALTER TABLE codebuddyAccounts RENAME TO codebuddyAccounts_old");

      // 2. Create the new table with the composite unique constraint
      db.exec(`
        CREATE TABLE codebuddyAccounts (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          password TEXT NOT NULL,
          profileDir TEXT,
          ammailAlias TEXT,
          signupMethod TEXT DEFAULT 'google',
          apiKey TEXT,
          apiKeyStatus TEXT DEFAULT 'pending',
          lastError TEXT,
          lastRunAt INTEGER,
          createdAt TEXT NOT NULL,
          provider TEXT DEFAULT 'codebuddy',
          canvaEnrolled INTEGER DEFAULT 0,
          UNIQUE(email, provider)
        )
      `);

      // 3. Recreate index
      db.exec("CREATE INDEX IF NOT EXISTS idx_cba_email ON codebuddyAccounts(email)");

      // 4. Copy data, ignoring any (email, provider) duplicates.
      db.exec(`
        INSERT INTO codebuddyAccounts (${COLUMNS})
        SELECT ${COLUMNS}
        FROM codebuddyAccounts_old
        ON CONFLICT (email, provider) DO NOTHING
      `);

      // 5. Drop old table
      db.exec("DROP TABLE codebuddyAccounts_old");
      return;
    }

    // ── SQLite path (original behaviour) ──────────────────────────────────
    // 1. Rename existing table
    db.exec("ALTER TABLE codebuddyAccounts RENAME TO codebuddyAccounts_old");

    // 2. Create new table with unique(email, provider) constraint
    db.exec(`
      CREATE TABLE codebuddyAccounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        password TEXT NOT NULL,
        profileDir TEXT,
        ammailAlias TEXT,
        signupMethod TEXT DEFAULT 'google',
        apiKey TEXT,
        apiKeyStatus TEXT DEFAULT 'pending',
        lastError TEXT,
        lastRunAt INTEGER,
        createdAt TEXT NOT NULL,
        provider TEXT DEFAULT 'codebuddy',
        canvaEnrolled INTEGER DEFAULT 0,
        UNIQUE(email, provider)
      )
    `);

    // 3. Recreate index
    db.exec("CREATE INDEX IF NOT EXISTS idx_cba_email ON codebuddyAccounts(email)");

    // 4. Copy data from old table, ignoring any constraint violations.
    db.exec(`
      INSERT OR IGNORE INTO codebuddyAccounts (
        id, email, password, profileDir, ammailAlias, signupMethod,
        apiKey, apiKeyStatus, lastError, lastRunAt, createdAt, provider, canvaEnrolled
      )
      SELECT
        id, email, password, profileDir, ammailAlias, signupMethod,
        apiKey, apiKeyStatus, lastError, lastRunAt, createdAt, provider, canvaEnrolled
      FROM codebuddyAccounts_old
    `);

    // 5. Drop old table
    db.exec("DROP TABLE codebuddyAccounts_old");
  }
};
