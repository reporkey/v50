-- Per-IP rate-limit counters, replacing the non-atomic KV pattern (audit F3).
-- Bucket identity lives in the key (minute number / UTC date), so a stale row
-- can never be confused with a live one; expires_at exists purely for GC.
CREATE TABLE IF NOT EXISTS rate_counters (
  k          TEXT PRIMARY KEY,
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_counters_expires
  ON rate_counters (expires_at);
