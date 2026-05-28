import { createHash } from 'node:crypto';

// Node-side corpus id helper used by scripts/import-corpus.mjs and
// scripts/index-corpus.mjs. The Worker runtime uses an async sibling at
// functions/_lib/corpus-id.js — both MUST produce identical
// v50_<sha12(text)> ids, since D1 rows and Vectorize entries share the
// same id and any drift would silently break retrieval.
export function resolveCorpusId(item) {
  if (item && typeof item.id === 'string' && item.id.trim()) {
    return item.id.trim();
  }

  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `v50_${hash}`;
}
