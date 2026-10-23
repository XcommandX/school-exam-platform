CREATE TABLE IF NOT EXISTS sat_account_entities (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('attempts', 'wrong-book', 'settings')),
    entity_id TEXT NOT NULL,
    value_json TEXT,
    summary_json TEXT NOT NULL DEFAULT '{}',
    revision INTEGER NOT NULL CHECK(revision > 0),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1)),
    payload_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, kind, entity_id)
);
CREATE INDEX IF NOT EXISTS sat_account_entity_index ON sat_account_entities(user_id, kind, entity_id);
CREATE TABLE IF NOT EXISTS sat_account_mutations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,
    UNIQUE(user_id, kind, entity_id, mutation_id)
);
CREATE INDEX IF NOT EXISTS sat_account_mutation_entity ON sat_account_mutations(user_id,kind,entity_id,sequence DESC);
