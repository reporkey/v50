CREATE TABLE IF NOT EXISTS corpus_items (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  source TEXT,
  source_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS copied_outputs (
  id TEXT PRIMARY KEY,
  keywords TEXT NOT NULL,
  copied_text TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  reference_ids TEXT NOT NULL,
  previous_outputs TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_copied_outputs_created_at
  ON copied_outputs (created_at);
