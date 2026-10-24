/** Auth-only SQLite schema. Account/exam data belongs to the separate data store.
 * Apply inside storage.transactionSync(); rerunning never resets users or setup.
 * Original unified-platform table/column names are retained. security_version
 * invalidates an in-flight password check even after disable -> enable or a
 * role change -> reversal. auth_meta contains no submitted credentials.
 */
export const AUTH_SCHEMA_VERSION = '3';

export const AUTH_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS auth_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'student')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_login_at INTEGER,
    security_version INTEGER NOT NULL DEFAULT 0 CHECK(security_version >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at)',
  `CREATE TABLE IF NOT EXISTS login_failures (
    bucket TEXT PRIMARY KEY,
    failures INTEGER NOT NULL CHECK(failures >= 0),
    expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS login_failures_expiry ON login_failures(expires_at)',
  `CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at INTEGER NOT NULL,
    actor_id TEXT,
    action TEXT NOT NULL,
    target_id TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  )`,
  'CREATE INDEX IF NOT EXISTS audit_events_time ON audit_events(occurred_at)',
  // v3 removes unpublished email approvals, never existing accounts/sessions.
  'DROP TABLE IF EXISTS pending_registrations',
  `CREATE TABLE IF NOT EXISTS registration_requests (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT,
    status TEXT NOT NULL CHECK(status IN ('hashing','pending','approved','rejected')),
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    reviewed_at INTEGER,
    reviewed_order INTEGER NOT NULL DEFAULT 0,
    reviewed_by TEXT,
    reviewer_name TEXT,
    CHECK(status != 'pending' OR password_hash IS NOT NULL),
    CHECK(status NOT IN ('approved','rejected') OR password_hash IS NULL)
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS registration_requests_active_username ON registration_requests(username_key) WHERE status IN ('hashing','pending')",
  'CREATE INDEX IF NOT EXISTS registration_requests_expiry ON registration_requests(expires_at)',
  'CREATE INDEX IF NOT EXISTS registration_requests_history ON registration_requests(reviewed_at)',
  `CREATE TABLE IF NOT EXISTS registration_limits (
    bucket TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL CHECK(attempts >= 0),
    expires_at INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS registration_limits_expiry ON registration_limits(expires_at)',
]);
