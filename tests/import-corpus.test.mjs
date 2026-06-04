import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportSql, validateCorpus } from '../scripts/import-corpus.mjs';

// --- F1: imported rows must be visible to RAG retrieval ---
// generate.js fetchCorpusRows requires `status='approved' AND indexed_at IS
// NOT NULL`; an import that leaves indexed_at NULL produces rows Vectorize
// matches but D1 silently drops from every retrieval.

test('buildImportSql stamps indexed_at on insert so imported rows are retrievable', () => {
  const sql = buildImportSql([{ text: 'v我50' }]);
  assert.match(sql, /INSERT INTO corpus_items \(id, text, author, source_url, indexed_at\)/);
  assert.match(sql, /CURRENT_TIMESTAMP/);
});

test('buildImportSql preserves an existing indexed_at on re-import (ON CONFLICT)', () => {
  const sql = buildImportSql([{ text: 'v我50' }]);
  assert.match(sql, /indexed_at = COALESCE\(corpus_items\.indexed_at, excluded\.indexed_at\)/);
});

// --- F30: declared item_count must match the items array ---

test('validateCorpus rejects a corpus whose declared item_count mismatches items.length', () => {
  assert.throws(
    () => validateCorpus({ item_count: 2, items: [{ text: 'a' }] }),
    /item_count/
  );
});

test('validateCorpus accepts a corpus whose declared item_count matches', () => {
  const items = validateCorpus({ item_count: 1, items: [{ text: 'a' }] });
  assert.equal(items.length, 1);
});

// --- existing behavior, locked in ---

test('validateCorpus accepts a bare array (no metadata wrapper)', () => {
  const items = validateCorpus([{ text: 'a' }, { text: 'b' }]);
  assert.equal(items.length, 2);
});

test('validateCorpus rejects items with empty or missing text', () => {
  assert.throws(() => validateCorpus({ items: [{ text: '   ' }] }), /non-empty text/);
  assert.throws(() => validateCorpus({ items: [{ author: 'x' }] }), /non-empty text/);
});

test('validateCorpus rejects duplicate corpus ids', () => {
  assert.throws(
    () => validateCorpus({ items: [{ text: 'same' }, { text: 'same' }] }),
    /Duplicate corpus id/
  );
});

test('buildImportSql escapes single quotes and renders missing fields as NULL', () => {
  const sql = buildImportSql([{ text: "it's KFC" }]);
  assert.match(sql, /'it''s KFC'/);
  assert.match(sql, /NULL, NULL/);
});

test('buildImportSql derives v50_<sha12> ids from text', () => {
  const sql = buildImportSql([{ text: 'v我50' }]);
  assert.match(sql, /'v50_[0-9a-f]{12}'/);
});
