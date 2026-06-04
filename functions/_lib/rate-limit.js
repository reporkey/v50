// Shared per-IP rate limiting on D1 — replaces the per-endpoint KV
// GET→+1→PUT pattern, which was non-atomic and could be overshot by
// concurrent bursts (audit F3). The increment statement below is atomic in
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
