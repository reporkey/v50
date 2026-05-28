// Worker-side mirror of scripts/corpus-id.mjs. Workers have Web Crypto
// (async subtle.digest) but no node:crypto, so this version is async.
// scripts/corpus-id.mjs stays sync because import-corpus.mjs uses it in a
// hot synchronous loop. Both MUST produce the same v50_<sha12(text)> id —
// D1 rows and Vectorize entries share the id, so any drift would silently
// break retrieval.

const encoder = new TextEncoder();

export async function resolveCorpusId(item) {
  if (item && typeof item.id === 'string' && item.id.trim()) {
    return item.id.trim();
  }

  const text = typeof item?.text === 'string' ? item.text.trim() : '';
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v50_${hex.slice(0, 12)}`;
}
