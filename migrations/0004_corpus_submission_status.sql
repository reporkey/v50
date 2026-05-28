ALTER TABLE corpus_items ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE corpus_items ADD COLUMN submitted_at TEXT;
ALTER TABLE corpus_items ADD COLUMN approved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_corpus_items_status
  ON corpus_items (status, created_at);
