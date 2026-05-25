import { createHash } from 'node:crypto';

// The corpus id is the shared key between D1 and the Vectorize index, so the
// import and index scripts must resolve it identically — otherwise a row and its
// vector end up under different ids and retrieval silently misses. Contributors
// don't supply an id; when it's missing we derive a stable one from the text, so
// the same line always maps to the same id across both stores and across runs.
export function resolveCorpusId(item) {
  if (item && typeof item.id === 'string' && item.id.trim()) {
    return item.id.trim();
  }

  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return `v50_${hash}`;
}
