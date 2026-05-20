ALTER TABLE corpus_items ADD COLUMN reference_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE corpus_items ADD COLUMN accepted_reference_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE corpus_items ADD COLUMN last_referenced_at TEXT;
ALTER TABLE corpus_items ADD COLUMN last_accepted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_corpus_items_reference_count
  ON corpus_items (reference_count);

CREATE INDEX IF NOT EXISTS idx_corpus_items_accepted_reference_count
  ON corpus_items (accepted_reference_count);
