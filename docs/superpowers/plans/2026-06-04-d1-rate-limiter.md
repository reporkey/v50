# D1 Atomic Rate Limiter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the non-atomic KV rate limiter with a D1-backed atomic counter shared by all four API endpoints (audit F3/F13/F16/F21).

**Architecture:** One new D1 table (`rate_counters`) incremented via `INSERT ... ON CONFLICT ... SET n=n+1 RETURNING n` (atomic, single-primary). One shared module `functions/_lib/rate-limit.js` exposing `getClientIp` / `isLocalDevRequest` / `enforce` / `peek` / `charge`. The four endpoints drop their copy-pasted KV helpers; the `RATE_LIMIT` KV binding is retired. Spec: `docs/superpowers/specs/2026-06-04-d1-rate-limiter-design.md`.

**Tech Stack:** Cloudflare Pages Functions (ES modules), D1 (SQLite), node:test for unit tests, wrangler for local D1 verification.

---

### Task 1: Migration + SQL semantics proof

**Files:**
- Create: `migrations/0006_rate_counters.sql`

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply locally and prove the atomic upsert returns 1, 2, 3**

Run:
```bash
npx wrangler d1 migrations apply v50-db --local
for i in 1 2 3; do npx wrangler d1 execute v50-db --local --json --command \
  "INSERT INTO rate_counters (k, n, expires_at) VALUES ('t:k', 1, 9999999999) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n"; done
```
Expected: the three commands return n = 1, then 2, then 3.

- [ ] **Step 3: Prove GC deletes only expired rows**

Run:
```bash
npx wrangler d1 execute v50-db --local --command \
  "INSERT INTO rate_counters (k, n, expires_at) VALUES ('t:old', 1, 1) ON CONFLICT(k) DO UPDATE SET n=n+1; DELETE FROM rate_counters WHERE expires_at < strftime('%s','now'); SELECT k FROM rate_counters"
```
Expected: `t:k` remains, `t:old` is gone. Then clean up: `DELETE FROM rate_counters`.

- [ ] **Step 4: Commit**

```bash
git add migrations/0006_rate_counters.sql
git commit -m "Add rate_counters table for D1 atomic rate limiting"
```

---

### Task 2: Shared module `functions/_lib/rate-limit.js` (TDD)

**Files:**
- Create: `tests/rate-limit.test.mjs`
- Create: `functions/_lib/rate-limit.js`

- [ ] **Step 1: Write the failing tests**

`tests/rate-limit.test.mjs` — a FakeD1 emulates exactly the three SQL shapes the
module issues (SELECT n / INSERT..RETURNING / DELETE), backed by a Map, with a
call log so tests can assert *no write happened* (F13):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getClientIp, enforce, peek, charge } from '../functions/_lib/rate-limit.js';

// Minimal D1 stand-in: dispatches on SQL text, counts in a Map, logs calls.
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
          async first() { return db.#exec(sql, args).row; },
          async run() { return { results: [db.#exec(sql, args).row].filter(Boolean) }; }
        };
      }
    };
  }
  async batch(stmts) {
    return stmts.map((s) => ({ results: [this.#exec(s.sql, s.args).row].filter(Boolean) }));
  }
  #exec(sql, args) {
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
```

- [ ] **Step 2: Run tests, verify they fail on missing module**

Run: `node --test 'tests/rate-limit.test.mjs'`
Expected: FAIL — `does not provide an export named 'enforce'` (module absent).

- [ ] **Step 3: Implement the module**

`functions/_lib/rate-limit.js`:

```js
// Shared per-IP rate limiting on D1 — replaces the per-endpoint KV
// GET→+1→PUT pattern, which was non-atomic and could be overshot by
// concurrent bursts (audit F3). The single statement below is atomic in
// SQLite: concurrent callers each see a distinct n, so the (limit+1)th
// caller of a bucket always trips, no matter how parallel the burst.
import { CONFIG } from './config.js';

const INCREMENT_SQL = `INSERT INTO rate_counters (k, n, expires_at) VALUES (?1, 1, ?2)
ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n`;
const READ_SQL = 'SELECT n FROM rate_counters WHERE k = ?1';
const GC_SQL = 'DELETE FROM rate_counters WHERE expires_at < ?1';

// Only CF-Connecting-IP identifies the caller — it is set by Cloudflare and
// not client-forgeable. No x-forwarded-for fallback, no shared 'unknown'
// bucket (audit F16). Returns null when absent; callers fail closed.
export function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || null;
}

export function isLocalDevRequest(request) {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

// Check-and-consume. rules: [{ scope, period: 'minute'|'day', limit }].
// Returns null when admitted, or the tripped rule { scope, period, limit }.
// Two steps: a read-only pre-check so hammering an exhausted bucket costs no
// writes (audit F13), then an atomic increment whose RETURNING value is the
// authoritative verdict — racers that slip past the pre-check are caught here.
export async function enforce(db, ip, rules, context) {
  if (!db) return null; // mirror the old `if (!kv)` permissiveness
  if (!ip) return { ...rules[0] }; // fail closed: unidentifiable caller
  const now = Date.now();
  try {
    const reads = await db.batch(rules.map((rule) => db.prepare(READ_SQL).bind(bucketKey(rule, ip, now))));
    for (let i = 0; i < rules.length; i++) {
      if (Number(reads[i]?.results?.[0]?.n ?? 0) >= rules[i].limit) return { ...rules[i] };
    }

    const writes = await db.batch(
      rules.map((rule) => db.prepare(INCREMENT_SQL).bind(bucketKey(rule, ip, now), expiresAt(rule, now)))
    );
    let verdict = null;
    let newBucket = false;
    for (let i = 0; i < rules.length; i++) {
      const n = Number(writes[i]?.results?.[0]?.n ?? 0);
      if (n === 1) newBucket = true;
      if (n > rules[i].limit && !verdict) verdict = { ...rules[i] };
    }
    if (newBucket) scheduleGc(db, now, context);
    return verdict;
  } catch (error) {
    // Availability over strictness for a meme site: if D1 is down the corpus
    // retrieval is degraded anyway, so admit rather than block everyone.
    console.error('Rate limiter unavailable, failing open', error);
    return null;
  }
}

// Read-only: is this IP already at the cap? Used by submit.js BEFORE its
// duplicate check so a rejection never consumes quota.
export async function peek(db, ip, rule) {
  if (!db) return false;
  if (!ip) return true; // fail closed
  try {
    const row = await db.prepare(READ_SQL).bind(bucketKey(rule, ip, Date.now())).first();
    return Number(row?.n ?? 0) >= rule.limit;
  } catch (error) {
    console.error('Rate limiter peek failed, failing open', error);
    return false;
  }
}

// Unconditional consume. Used by submit.js AFTER a genuinely new insert, so
// duplicates and validation failures never burn the daily quota.
export async function charge(db, ip, rule, context) {
  if (!db || !ip) return;
  const now = Date.now();
  try {
    const result = await db.prepare(INCREMENT_SQL).bind(bucketKey(rule, ip, now), expiresAt(rule, now)).run();
    if (Number(result?.results?.[0]?.n ?? 0) === 1) scheduleGc(db, now, context);
  } catch (error) {
    console.error('Rate limiter charge failed', error);
  }
}

function bucketKey(rule, ip, now) {
  const bucket = rule.period === 'minute'
    ? `m:${Math.floor(now / 60000)}`
    : `d:${new Date(now).toISOString().slice(0, 10)}`;
  return `rl:${rule.scope}:${ip}:${bucket}`;
}

function expiresAt(rule, now) {
  const ttl = rule.period === 'minute'
    ? CONFIG.rateLimit.minuteBucketTtlSeconds
    : CONFIG.rateLimit.dayBucketTtlSeconds;
  return Math.floor(now / 1000) + ttl;
}

// Opportunistic GC, at most once per new bucket. Best-effort by design: GC is
// not a must-complete state transition, so waitUntil is appropriate here.
function scheduleGc(db, now, context) {
  const task = db
    .prepare(GC_SQL)
    .bind(Math.floor(now / 1000))
    .run()
    .catch((error) => console.error('Rate counter GC failed', error));
  if (context && typeof context.waitUntil === 'function') context.waitUntil(task);
}
```

- [ ] **Step 4: Run tests, verify all pass**

Run: `npm test`
Expected: all tests pass (9 import-corpus + 11 rate-limit).

- [ ] **Step 5: Add the new files to `npm run check`, run it**

In `package.json`, append to the `check` script: `&& node --check functions/_lib/rate-limit.js`
Run: `npm run check` — expected OK.

- [ ] **Step 6: Commit**

```bash
git add tests/rate-limit.test.mjs functions/_lib/rate-limit.js package.json
git commit -m "Add shared D1 atomic rate limiter module"
```

---

### Task 3: Migrate generate.js (F3 + F21)

**Files:**
- Modify: `functions/api/generate.js` (imports; lines 30-50 of handleGenerate; delete isRateLimited / incrementCounter / getClientIp / isLocalDevRequest helpers at 528-569)

- [ ] **Step 1: Update the import and handler**

Add to imports at top:
```js
import { CONFIG } from '../_lib/config.js';
import { enforce, getClientIp, isLocalDevRequest } from '../_lib/rate-limit.js';
```

Add the rules constant right below:
```js
const RATE_RULES = [
  { scope: 'gen', period: 'minute', limit: CONFIG.rateLimit.minutely },
  { scope: 'gen', period: 'day', limit: CONFIG.rateLimit.daily }
];
```

Replace handleGenerate steps 1-2 (current lines 31-50). Binding check now comes
FIRST so a misconfigured deploy 503s without charging anyone's quota (F21), and
the verdict branches on `period` (the old KV helper called it `scope`):

```js
    // 1. Parse + validate request.
    const payload = await measure(timing, 'read_json_ms', () => readJson(request));
    const input = measureSync(timing, 'normalize_ms', () => normalizeInput(payload));

    // 2. Server misconfiguration is the server's fault — check bindings before
    //    spending the caller's rate-limit quota.
    if (!env.AI || !env.DB || !env.V50_INDEX) {
      timing.total_ms = elapsedMs(startedAt);
      return timedJson({ ok: false, error: '生成服务未配置', timing }, timing, 503);
    }

    // 3. Per-IP rate limit (D1 atomic counters), bypassed on localhost so dev isn't throttled.
    const ip = getClientIp(request);
    const limited =
      !isLocalDevRequest(request) &&
      (await measure(timing, 'rate_limit_ms', () => enforce(env.DB, ip, RATE_RULES, context)));
    if (limited) {
      timing.total_ms = elapsedMs(startedAt);
      const errorMsg = limited.period === 'day'
        ? `今日请求次数已达上限（每日 ${limited.limit} 次），请明天再试`
        : `请求太频繁（每分钟限 ${limited.limit} 次），请稍后再试`;
      return timedJson({ ok: false, error: errorMsg, timing }, timing, 429);
    }
```

- [ ] **Step 2: Delete the dead local helpers**

Remove from generate.js: `isRateLimited` (lines ~528-549), `isLocalDevRequest`
(~551-554), `incrementCounter` (~556-561), and the local `getClientIp` (~563-569).
Renumber comments 3→4 etc. if present.

- [ ] **Step 3: Verify**

Run: `npm run check && npm test`
Expected: both pass. Also `grep -n RATE_LIMIT functions/api/generate.js` returns nothing.

- [ ] **Step 4: Commit**

```bash
git add functions/api/generate.js
git commit -m "generate: D1 atomic rate limit, binding check before quota"
```

---

### Task 4: Migrate copy.js and list.js

**Files:**
- Modify: `functions/api/copy.js` (line 1 import; lines 30-32; delete isMinuteRateLimited/getClientIp/isLocalDevRequest helpers at 144-168)
- Modify: `functions/api/corpus/list.js` (line 2 import; lines 20-22; delete helpers at 112-136)

- [ ] **Step 1: copy.js**

Import (note path depth):
```js
import { enforce, getClientIp, isLocalDevRequest } from '../_lib/rate-limit.js';
```

Replace lines 30-32 with:
```js
    if (!isLocalDevRequest(request)) {
      const limited = await enforce(env.DB, getClientIp(request), [
        { scope: 'copy', period: 'minute', limit: CONFIG.rateLimit.minutely }
      ], context);
      if (limited) return json({ ok: false, error: 'rate_limited' }, 429);
    }
```

Delete local `isMinuteRateLimited`, `getClientIp`, `isLocalDevRequest`.

- [ ] **Step 2: list.js — same change**

Import: `import { enforce, getClientIp, isLocalDevRequest } from '../../_lib/rate-limit.js';`

Replace lines 20-22 with:
```js
    if (!isLocalDevRequest(request)) {
      const limited = await enforce(env.DB, getClientIp(request), [
        { scope: 'list', period: 'minute', limit: CONFIG.rateLimit.minutely }
      ], context);
      if (limited) return json({ ok: false, error: 'rate_limited' }, 429);
    }
```

Delete local `isMinuteRateLimited`, `getClientIp`, `isLocalDevRequest`.

Note: `handleList(context)` already receives the full context — destructure stays
`const { request, env } = context;` and `context` is passed to enforce for GC.

- [ ] **Step 3: Verify + commit**

Run: `npm run check && npm test && grep -rn "RATE_LIMIT\|isMinuteRateLimited" functions/api/copy.js functions/api/corpus/list.js`
Expected: checks pass; grep finds nothing.

```bash
git add functions/api/copy.js functions/api/corpus/list.js
git commit -m "copy+list: shared D1 rate limiter"
```

---

### Task 5: Migrate submit.js

**Files:**
- Modify: `functions/api/corpus/submit.js` (imports; lines 26-32, 52-55; delete submitDayKey/isSubmitOverDailyLimit/chargeSubmit at 86-107 and local getClientIp/isLocalDevRequest)
- Modify: `functions/_lib/config.js` (drop the now-dead `submitRateLimit.dayBucketTtlSeconds`)

- [ ] **Step 1: submit.js**

Import: `import { peek, charge, getClientIp, isLocalDevRequest } from '../../_lib/rate-limit.js';`

Add constant:
```js
const SUBMIT_RULE = { scope: 'submit', period: 'day', limit: CONFIG.submitRateLimit.daily };
```

Replace lines 29-32 (peek before dup check — ordering semantics unchanged):
```js
    // Reject IPs already at their daily cap (read-only — does not consume quota).
    if (enforceLimit && (await peek(env.DB, ip, SUBMIT_RULE))) {
      return json({ ok: false, error: '今日投稿次数已达上限' }, 429);
    }
```

Replace lines 52-55 (charge only after a genuinely new row):
```js
    // Charge the daily quota only after a genuinely new row is stored.
    if (enforceLimit) {
      await charge(env.DB, ip, SUBMIT_RULE, context);
    }
```

`handleSubmit` must receive `context` (check its signature; it currently
destructures `{ request, env }` — keep that and pass `context` to charge).

Delete `submitDayKey`, `isSubmitOverDailyLimit`, `chargeSubmit`, local
`getClientIp`, local `isLocalDevRequest`.

- [ ] **Step 2: config.js — remove dead knob**

```js
  submitRateLimit: {
    daily: 5
  }
```
(The TTL now comes from `CONFIG.rateLimit.dayBucketTtlSeconds` inside the lib.)

- [ ] **Step 3: Verify + commit**

Run: `npm run check && npm test && grep -rn "RATE_LIMIT" functions/`
Expected: pass; grep finds nothing under functions/.

```bash
git add functions/api/corpus/submit.js functions/_lib/config.js
git commit -m "submit: shared D1 rate limiter, peek/charge split preserved"
```

---

### Task 6: Retire the KV binding

**Files:**
- Modify: `wrangler.toml` (delete lines 9-12, the `[[kv_namespaces]]` block)
- Modify: `package.json` (dev script: remove ` --kv RATE_LIMIT`)

- [ ] **Step 1: Edit both files**

wrangler.toml after the change has no `kv_namespaces` section. package.json dev
script becomes: `"dev": "wrangler pages dev public --ai AI"`.

- [ ] **Step 2: Verify nothing references the binding anymore**

Run: `grep -rn "RATE_LIMIT" --include="*.js" --include="*.toml" --include="*.json" . | grep -v node_modules | grep -v docs/ | grep -v '.wrangler'`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add wrangler.toml package.json
git commit -m "Retire RATE_LIMIT KV binding"
```

---

### Task 7: Deploy and prove F3 is fixed in production

- [ ] **Step 1: Apply the migration to remote D1 FIRST** (old code ignores the
  new table; new code fails open if the table were missing — order is safe
  either way, but migrate-first is cleaner)

Run: `npx wrangler d1 migrations apply v50-db --remote`
Expected: 0006 applied.

- [ ] **Step 2: Push (triggers Pages production deploy)**

```bash
git push origin main
```

- [ ] **Step 3: Smoke-test production**

```bash
curl -s -D - -o /dev/null https://v50.reporkey.com/healthz | grep -iE '^(HTTP|x-health)'
```
Expected: 200, `d1=ok;vectorize=ok`.

- [ ] **Step 4: Concurrency proof on /api/corpus/list** (10/min limit; cheap —
  no AI calls; own IP recovers in 60s)

```bash
seq 1 20 | xargs -P 20 -I{} curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST https://v50.reporkey.com/api/corpus/list \
  -H 'Content-Type: application/json' -d '{"status":"approved","page":1}' | sort | uniq -c
```
Expected: exactly 10 × 200 and 10 × 429. (Old KV limiter would admit most or
all 20.) Wait 60s afterwards so the minute bucket resets.

- [ ] **Step 5: Verify counters landed in remote D1**

```bash
npx wrangler d1 execute v50-db --remote --json --command \
  "SELECT k, n FROM rate_counters ORDER BY k"
```
Expected: an `rl:list:<ip>:m:<bucket>` row with n ≈ 11 (10 admitted + 1 caught
by the RETURNING verdict).

- [ ] **Step 6: Update memory + report to user in plain language**

---

## Self-Review Notes

- Spec coverage: F3 (Task 1+2 atomic SQL, Task 7 proof), F13 (enforce pre-check
  test), F16 (getClientIp test + fail-closed test), F21 (Task 3 reorder),
  KV retirement (Task 6), submit ordering preserved (Task 5). UTC buckets kept.
  No global budget. ✓
- Verdict field rename: old `limited.scope` ('day'/'minute') → new
  `limited.period`; generate.js message branch updated in Task 3 accordingly. ✓
- `context` is threaded to enforce/charge for waitUntil GC in all endpoints. ✓
- Known behavior change (acceptable): KV counters are abandoned at deploy time,
  so per-IP quotas effectively reset once at rollout.
