# D1 Atomic Rate Limiter — Design

Date: 2026-06-04
Status: approved

## Problem

The 2026-06-04 repo audit confirmed four defects in the current KV-based rate limiting
(findings F3/F13/F16/F21):

- **F3 (High):** `incrementCounter` is a non-atomic GET → +1 → PUT. N concurrent
  requests from one IP all read the same stale count, all pass the check, and all reach
  Workers AI before any PUT lands. The 10/min and 40/day caps can be overshot by an
  arbitrary factor in a single burst. KV's eventual consistency (up to ~60s across
  edge locations) widens the window. The same pattern is copy-pasted in
  `generate.js`, `copy.js`, and `corpus/list.js`.
- **F13:** already-over-limit requests still cost 2 KV reads + 2 KV writes each —
  rejection should be read-only.
- **F16:** `getClientIp` falls back to the client-controlled `x-forwarded-for`
  header, then to a shared `'unknown'` bucket. Duplicated in three files.
- **F21:** `generate.js` charges the caller's quota before checking that the
  AI/DB/Vectorize bindings exist, so probes against a misconfigured deploy burn the
  user's daily quota and then 429 instead of the truthful 503.

Cloudflare's native Rate Limiting binding was evaluated and rejected: it is not
supported on Pages Functions, counts per-colo (explicitly "not an accurate
accounting system"), and supports only 10s/60s periods (no daily caps).

## Decisions (made with the project owner)

1. **Backend: D1 atomic counters.** The `DB` binding already exists on every
   endpoint; D1's single-primary writes make `n = n + 1` genuinely serial.
2. **No global daily AI budget.** Workers AI's own daily quota is the backstop;
   `generate.js` already maps `quota_exhausted` to a user-facing error.
3. **Scope: all four endpoints** (`generate`, `copy`, `corpus/list`,
   `corpus/submit`) migrate to one shared module; the `RATE_LIMIT` KV binding is
   retired.
4. **Day buckets stay UTC** (owner declined the Beijing-midnight change).
5. Limits and user-facing 429 messages are unchanged: generate 10/min + 40/day,
   copy 10/min, list 10/min, submit 5/day. `isLocalDevRequest` bypass unchanged.

## Data model

New migration `migrations/0006_rate_counters.sql`:

```sql
CREATE TABLE IF NOT EXISTS rate_counters (
  k          TEXT PRIMARY KEY,  -- 'rl:{scope}:{ip}:m:{minuteBucket}' or ':d:{YYYY-MM-DD}'
  n          INTEGER NOT NULL,
  expires_at INTEGER NOT NULL   -- unix seconds; GC only — correctness never reads it
);
CREATE INDEX IF NOT EXISTS idx_rate_counters_expires ON rate_counters (expires_at);
```

Bucket identity lives in the key (minute number / UTC date), so a stale row can
never be confused with a live one; `expires_at` exists purely so old rows can be
deleted.

The atomic increment is a single statement (D1 supports `RETURNING`):

```sql
INSERT INTO rate_counters (k, n, expires_at) VALUES (?1, 1, ?2)
ON CONFLICT(k) DO UPDATE SET n = n + 1
RETURNING n
```

Concurrent callers each receive a distinct n (1, 2, 3, …); the 11th caller of a
10-limit bucket necessarily sees n = 11. This is the fix for F3.

## Shared module: `functions/_lib/rate-limit.js`

```js
getClientIp(request)         // CF-Connecting-IP or null. No x-forwarded-for, no 'unknown'.
enforce(db, ip, rules, ctx)  // rules: [{ scope, period: 'minute'|'day', limit }]
                             // → null if admitted, { scope, period, limit } if limited
peek(db, ip, rule)           // read-only: true if rule's counter is already at/over limit
charge(db, ip, rule)         // atomic increment, no verdict — submit's post-insert charge
```

`enforce` is two steps:

1. **Read-only pre-check** (one batched SELECT over the rule keys): if any counter
   is already ≥ its limit, reject without writing (F13).
2. **Atomic increment** (batched) for all rules; if any `RETURNING n` exceeds its
   limit, reject. The returned value is the authoritative verdict — racers that
   slip past step 1 are caught here.

`peek`/`charge` preserve submit.js's existing split semantics: the daily quota is
checked before the duplicate lookup but only charged after a genuinely new row is
inserted.

**Missing IP** (`getClientIp` → null, request not local-dev): fail closed — treat
as limited and return the endpoint's standard 429. In production Cloudflare always
sets `CF-Connecting-IP`; absence means an abnormal path (F16).

**D1 error** (query throws): fail open — log via `console.error` and admit,
matching the current `if (!kv) return null` posture. Availability over strictness;
if D1 is down the corpus retrieval is degraded anyway.

**GC:** when an increment returns `n === 1` (a bucket's first hit), delete rows
with `expires_at < now` via `context.waitUntil` where a context is available,
otherwise fire-and-forget with a `.catch`. Cleanup is best-effort by design —
must-complete state transitions don't go in waitUntil (lesson from the approve.js
incident), but GC is not a state transition.

## Endpoint changes

| File | Change |
|---|---|
| `functions/api/generate.js` | Move AI/DB/V50_INDEX binding checks **above** rate limiting (F21). Replace `isRateLimited`/`incrementCounter`/`getClientIp` with `enforce(db, ip, [gen-minute-10, gen-day-40])`. |
| `functions/api/copy.js` | Replace local `isMinuteRateLimited`/`getClientIp` with `enforce` (copy-minute-10). |
| `functions/api/corpus/list.js` | Same as copy.js (list-minute-10). |
| `functions/api/corpus/submit.js` | Replace KV `isSubmitOverDailyLimit`/`chargeSubmit` with `peek`/`charge` (submit-day-5); check/charge ordering unchanged. |
| `wrangler.toml` | Remove the `RATE_LIMIT` KV binding. |
| `package.json` | Remove `--kv RATE_LIMIT` from the `dev` script. |
| `functions/_lib/config.js` | Rate-limit knobs unchanged; nothing new added. |

User-visible behavior is identical: same limits, same Chinese 429 messages, same
local-dev bypass.

## Out of scope

- Global daily AI budget (declined — Workers AI quota is the backstop).
- `maxCompletionTokens` reduction (F14 remainder, unrelated to limiting).
- Beijing-time day buckets (declined).
- app.js 429-message handling (audit F4 — separate fix).

## Testing

1. **Unit (`node --test`, stub db):** key/bucket construction; enforce's
   pre-check short-circuit (no increment when already over); verdict on
   `RETURNING n > limit`; missing-IP fail-closed; D1-error fail-open;
   peek/charge split semantics.
2. **SQL semantics (`wrangler d1 execute --local`):** migration applies; the
   upsert returns 1, 2, 3… under repeated execution; GC delete removes only
   expired rows.
3. **Concurrency proof (manual, local dev server):** fire 20 parallel requests at
   one endpoint from one IP; assert ≤ 10 admitted (direct F3 evidence).
4. **Post-deploy smoke:** /healthz green; one real generate; 11th rapid request
   from one IP gets 429.
