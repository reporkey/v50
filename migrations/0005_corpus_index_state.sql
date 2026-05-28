ALTER TABLE corpus_items ADD COLUMN indexed_at TEXT;

-- Backfill: every existing approved row was indexed via the seed flow
-- (scripts/index-corpus.mjs) before this migration shipped, so mark them
-- as indexed using the best timestamp we have. New web submissions go
-- through approve.js which sets indexed_at only after Vectorize upsert
-- succeeds.
UPDATE corpus_items
  SET indexed_at = COALESCE(approved_at, created_at)
  WHERE status = 'approved' AND indexed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_corpus_items_indexed_at
  ON corpus_items (status, indexed_at);
