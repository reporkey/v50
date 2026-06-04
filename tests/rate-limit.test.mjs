import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp, enforce, peek, charge } from '../functions/_lib/rate-limit.js';

// Minimal D1 stand-in: dispatches on SQL text, counts in a Map, logs calls so
// tests can assert that rejection paths produce zero writes (audit F13).
class FakeD1 {
  constructor() {
    this.rows = new Map(); // k -> { n, expires_at }
    this.log = [];
    this.failAll = false;
  }
  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          sql,
          args,
          async first() { return db.exec(sql, args).row; },
          async run() { return { results: [db.exec(sql, args).row].filter(Boolean) }; }
        };
      }
    };
  }
  async batch(stmts) {
    return stmts.map((s) => ({ results: [this.exec(s.sql, s.args).row].filter(Boolean) }));
  }
  exec(sql, args) {
    if (this.failAll) throw new Error('d1 down');
    this.log.push({ sql, args });
    if (sql.startsWith('SELECT n FROM')) {
      const row = this.rows.get(args[0]);
      return { row: row ? { n: row.n } : null };
    }
    if (sql.startsWith('INSERT INTO rate_counters')) {
      const existing = this.rows.get(args[0]);
      const n = (existing?.n ?? 0) + 1;
      this.rows.set(args[0], { n, expires_at: args[1] });
      return { row: { n } };
    }
    if (sql.startsWith('DELETE FROM rate_counters')) {
      for (const [k, v] of this.rows) if (v.expires_at < args[0]) this.rows.delete(k);
      return { row: null };
    }
    throw new Error(`FakeD1: unexpected SQL: ${sql}`);
  }
  writes() { return this.log.filter((c) => c.sql.startsWith('INSERT') || c.sql.startsWith('DELETE')); }
}

function req(headers = {}) {
  return new Request('https://v50.reporkey.com/api/x', { headers });
}

const MIN10 = { scope: 'gen', period: 'minute', limit: 10 };
const DAY40 = { scope: 'gen', period: 'day', limit: 40 };

test('getClientIp returns CF-Connecting-IP and never trusts x-forwarded-for', () => {
  assert.equal(getClientIp(req({ 'CF-Connecting-IP': '1.2.3.4' })), '1.2.3.4');
  assert.equal(getClientIp(req({ 'x-forwarded-for': '6.6.6.6' })), null);
  assert.equal(getClientIp(req()), null);
});

test('enforce admits under the limit and counts both buckets', async () => {
  const db = new FakeD1();
  for (let i = 0; i < 10; i++) {
    assert.equal(await enforce(db, '1.2.3.4', [MIN10, DAY40]), null);
  }
  const minuteKey = [...db.rows.keys()].find((k) => k.includes(':m:'));
  assert.equal(db.rows.get(minuteKey).n, 10);
});

test('enforce rejects the 11th request in a minute with the tripped rule', async () => {
  const db = new FakeD1();
  for (let i = 0; i < 10; i++) await enforce(db, '1.2.3.4', [MIN10, DAY40]);
  const verdict = await enforce(db, '1.2.3.4', [MIN10, DAY40]);
  assert.equal(verdict.period, 'minute');
  assert.equal(verdict.limit, 10);
});

test('enforce rejection is read-only once the counter is at the limit (F13)', async () => {
  const db = new FakeD1();
  for (let i = 0; i < 11; i++) await enforce(db, '1.2.3.4', [MIN10]);
  const writesBefore = db.writes().length;
  await enforce(db, '1.2.3.4', [MIN10]);
  assert.equal(db.writes().length, writesBefore); // pre-check rejected: zero new writes
});

test('enforce fails closed when the IP is missing (F16)', async () => {
  const db = new FakeD1();
  const verdict = await enforce(db, null, [MIN10, DAY40]);
  assert.equal(verdict.period, 'minute');
  assert.equal(db.log.length, 0); // no D1 traffic for unidentifiable callers
});

test('enforce fails open when D1 throws', async () => {
  const db = new FakeD1();
  db.failAll = true;
  assert.equal(await enforce(db, '1.2.3.4', [MIN10]), null);
});

test('enforce without a db binding admits (mirrors old !kv behavior)', async () => {
  assert.equal(await enforce(undefined, '1.2.3.4', [MIN10]), null);
});

test('peek is read-only and true only at/over the limit', async () => {
  const db = new FakeD1();
  const SUB5 = { scope: 'submit', period: 'day', limit: 5 };
  assert.equal(await peek(db, '1.2.3.4', SUB5), false);
  for (let i = 0; i < 5; i++) await charge(db, '1.2.3.4', SUB5);
  assert.equal(await peek(db, '1.2.3.4', SUB5), true);
  const selects = db.log.filter((c) => c.sql.startsWith('SELECT'));
  assert.equal(selects.length, 2); // both peeks read, never wrote
});

test('charge uses rl:{scope}:{ip}:d:{YYYY-MM-DD} day keys', async () => {
  const db = new FakeD1();
  await charge(db, '1.2.3.4', { scope: 'submit', period: 'day', limit: 5 });
  const key = [...db.rows.keys()][0];
  assert.match(key, /^rl:submit:1\.2\.3\.4:d:\d{4}-\d{2}-\d{2}$/);
});

test('first hit of a new bucket schedules GC via waitUntil', async () => {
  const db = new FakeD1();
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  await enforce(db, '1.2.3.4', [MIN10], ctx);
  await Promise.all(waited);
  assert.equal(waited.length, 1);
  assert.ok(db.log.some((c) => c.sql.startsWith('DELETE FROM rate_counters')));
});
