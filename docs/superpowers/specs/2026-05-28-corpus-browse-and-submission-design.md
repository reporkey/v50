# Corpus Browse, Submission & Admin Approval — Design

**Date:** 2026-05-28
**Status:** Approved (spec-level)

## Goal

Give visitors a way to browse and search the corpus that powers RAG generation, and to contribute new V50 lines through the web. New submissions sit in a moderation queue until the maintainer approves them, at which point they are embedded into Vectorize and become available to the generator.

This replaces the PR-based contribution flow as the recommended path for individual contributions. The `references/v50_corpus.json` file remains as the initial-seed fixture only; the README will direct contributors to the website.

## User-facing surfaces

Three tabs on a single SPA at `/`, plus a hidden admin route.

- **生成** — the existing generator card. Unchanged.
- **语料** — paginated browse + substring search over `corpus_items`. A filter pill toggles between *已收录* (`status='approved'`), *待审核* (`status='pending'`), and *全部*. Default is *已收录*.
- **投稿** — form with `text` (20–180 chars, counter) and optional `author` (≤40 chars, placeholder *匿名*). Submit button is disabled until length is in range. On success: green toast *"投稿成功，等待审核"*. On `409 duplicate`: red toast *"这条已经在语料库里了"* with sub-line indicating whether existing copy is approved or pending. On `429`: red toast *"今日投稿次数已达上限"*. Textarea contents are preserved on any error so the user can edit and retry.
- **`/admin`** (separate HTML page, not in the tab nav) — first load prompts for the admin token via a small inline form; token is stored in `localStorage` under `v50-admin-token` and sent as `X-Admin-Token` on every admin call. Shows a queue of pending rows sorted oldest first, each with *通过* / *删除* buttons. A small "清除登录" link lets the admin wipe the stored token. No styling effort beyond what's needed to be usable.

The tab navigation lives in the top bar next to the brand mark. Switching tabs is client-side only (no route changes) so the existing generator state isn't lost when the user peeks at the corpus tab and comes back.

## Data model

One additive migration:

```sql
-- migrations/0004_corpus_submission_status.sql
ALTER TABLE corpus_items ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE corpus_items ADD COLUMN submitted_at TEXT;
ALTER TABLE corpus_items ADD COLUMN approved_at TEXT;
CREATE INDEX IF NOT EXISTS idx_corpus_items_status
  ON corpus_items (status, created_at);
```

- `status` defaults to `'approved'` so the existing seed rows remain live in RAG without a backfill.
- `submitted_at` is set only by the web submit endpoint; seed/PR rows keep it `NULL`, which is how the admin queue distinguishes them.
- `approved_at` is set when the approve endpoint flips a row.

Vectorize schema is unchanged. Only `status='approved'` rows are ever upserted. The approve path writes `metadata: { author }` to match what `scripts/index-corpus.mjs` already does.

The `corpus_items` primary key remains `v50_<sha12(text)>`, computed by `resolveCorpusId()`. That helper moves from `scripts/corpus-id.mjs` to `functions/_lib/corpus-id.js` and is re-exported from the original path so the existing `scripts/import-corpus.mjs` and `scripts/index-corpus.mjs` continue to work unchanged. (The web functions need it too, and Pages Functions can't import from `scripts/`.)

As a defense-in-depth measure, `functions/api/generate.js` `fetchCorpusRows()` will add `AND status = 'approved'` to its `SELECT` so a pending id can never be served as a reference, even if one somehow leaks into the reuse path.

## API surface

Three new Pages Functions, all POST + JSON, all reusing the existing CORS helper and JSON-parsing pattern from `generate.js`.

### `POST /api/corpus/list`

```
Request:  { q?: string, status?: 'approved' | 'pending' | 'all', page?: int, page_size?: int }
Response: 200 { ok: true, items: [...], total: int, page: int, page_size: int }
```

- `q` trimmed, clamped to 60 chars, LIKE wildcards escaped before binding.
- `status` defaults to `'approved'`. `'all'` is accepted; anything else is normalised to `'approved'`.
- `page_size` clamped to `[10, 50]`, default `20`.
- Order: `created_at DESC` by default; `submitted_at ASC` when `status='pending'`.
- Returns `{ id, text, author, source_url, status, created_at, approved_at }` per item.
- No rate-limit at the endpoint level; this is a public read path.

### `POST /api/corpus/submit`

```
Request:  { text: string, author?: string }
Response: 201 { ok: true, id, status: 'pending' }
        | 400 { ok: false, error: 'text_length' | 'text_required' | 'author_length' }
        | 409 { ok: false, error: 'duplicate', existing_status: 'approved' | 'pending' }
        | 429 { ok: false, error: '今日投稿次数已达上限' }
```

- Validation: `text` trimmed, length `∈ [20, 180]`; `author` ≤40 chars (default `'匿名'` if absent/blank).
- Compute `id` via the shared `resolveCorpusId()`. Pre-check existence and return `409` without inserting if a row with that id already exists. The 409 response includes `existing_status` so the frontend can show a precise toast.
- Insert with `status='pending'`, `submitted_at=CURRENT_TIMESTAMP`, `source_url=NULL`.
- Per-IP daily rate-limit via `env.RATE_LIMIT` KV under prefix `submit:<ip>:d:<yyyy-mm-dd>`, capped at 5 submissions/IP/day. Bypassed for localhost. Tunable via a new field in `functions/_lib/config.js`.

### `POST /api/admin/approve`

```
Header:   X-Admin-Token: <ADMIN_TOKEN secret>
Request:  { id: string, action: 'approve' | 'delete' }
Response: 200 { ok: true, id, status: 'approved' | 'deleted' }
        | 401 { ok: false, error: 'unauthorized' }
        | 404 { ok: false, error: 'not_found' }
        | 409 { ok: false, error: 'already_approved' }
        | 502 { ok: false, error: 'embed_failed' | 'upsert_failed' }
        | 503 { ok: false, error: 'admin_disabled' }
```

- Auth: constant-time compare against `env.ADMIN_TOKEN`. If the secret is unbound, the endpoint returns `503` for every request — the feature is effectively off in that environment.
- **`action='approve'`** runs in order:
  1. Read row; reject `404` if missing, `409` if `status='approved'`.
  2. Embed `row.text` via `@cf/baai/bge-m3`.
  3. Upsert into `env.V50_INDEX` with `{ id, values, metadata: author ? { author } : {} }`.
  4. `UPDATE corpus_items SET status='approved', approved_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`.
  - Steps 2/3 throw → return `502`, leave row as `pending`. The UPDATE is last so a row is only marked approved when its vector is actually queryable.
- **`action='delete'`** is best-effort destructive:
  1. Verify row exists.
  2. `env.V50_INDEX.deleteByIds([id])` — safe no-op if it was never indexed.
  3. `DELETE FROM corpus_items WHERE id=?`.
- The admin page can only call this endpoint; there's no listing endpoint specific to admin — it reuses `POST /api/corpus/list` with `status='pending'`.

## Frontend structure

The existing single-file `public/app.js` is splitting into per-tab modules to keep each file focused:

```
public/
  index.html         ── tab nav + three <section> containers + a discreet "管理" link in the footer pointing to /admin
  styles.css         ── extended with tab + table + form rules
  config.js          ── existing; extended with submit form constants (length limits, dedupe toast strings)
  app.js             ── tab orchestrator + the existing generator code (kept in place, no behaviour change)
  corpus.js          ── new; browse-tab logic (fetch list, render table, paging, search, filter pill)
  submit.js          ── new; submit-tab logic (form, validation, toast, dedupe handling)
  admin.html         ── new; minimal admin page (token gate + queue + buttons)
  admin.js           ── new; admin page logic
```

The split keeps each file under ~200 lines and matches the existing convention of plain classic scripts (no bundler, no modules — `file://` compatible).

## Abuse control summary

- **Submit endpoint:** 5/IP/day, KV-backed, same minute/day bucketing pattern as `generate.js`. Duplicate detection by deterministic id provides additional protection against spam-by-edit-distance-zero.
- **List endpoint:** no per-request limit. Page size capped server-side.
- **Admin endpoint:** token-gated. The token-bearing client (admin page) is also implicitly the only one that can call it.
- **No content filtering** in the submit endpoint beyond length validation. Moderation is the maintainer's job at approve time.

## Error handling

All endpoints follow the existing convention in `generate.js`: a single top-level try/catch returns a `{ ok: false, error }` payload with a Chinese user-facing message for 4xx/5xx, the response object short-circuits if validation throws a pre-built `Response`, and console.error is used for server-side diagnostics. Server-Timing is added to the approve endpoint (the embed + upsert calls are the slow part); list and submit are fast enough not to warrant it.

The approve endpoint deliberately does not retry the embed call. A failed approve leaves the row as `pending` so the admin can click *通过* again later.

## Testing & verification

There is no existing test harness in this repo — verification today is `npm run check` (syntax) plus manual probing via `npm run dev`. The new feature follows the same convention:

- `npm run check` extended to syntax-check the new function files and `public/corpus.js`, `public/submit.js`, `public/admin.js`.
- Manual verification checklist (to be carried out before merging):
  1. Migration runs cleanly on a local D1 and existing rows show `status='approved'`.
  2. Browse tab paginates and searches a known seed phrase.
  3. Submit accepts a fresh line, returns 201, the line appears in the browse tab under *待审核*.
  4. Resubmitting the same text returns 409 with the right `existing_status`.
  5. Submitting 6 times from the same IP triggers 429 on the 6th call.
  6. `/admin` rejects an empty / wrong token, accepts the right one.
  7. Approving a pending row makes it disappear from the queue, appear under *已收录*, and a subsequent `/api/generate` call with a matching keyword can retrieve it (verified by looking at `reference_ids` in the response).
  8. Deleting a row (pending or approved) removes it from D1 and Vectorize.
- Once it's deployed to a preview environment, repeat the checklist there to confirm KV rate-limiting and `env.AI` / `env.V50_INDEX` bindings work against remote bindings.

## Out of scope

- A user-visible submission history ("what I've submitted") — no user accounts means we'd have to key it off IP, which is fragile and not worth the complexity for a fan project.
- Edit-on-rejection — admins delete bad submissions; contributors can resubmit.
- Categorisation, tags, voting, comments — none of these are needed for RAG quality and the maintainer's stated workflow is a small daily moderation pass.
- Vector-based search in the browse tab — D1 substring is sufficient at current corpus size; revisit if the corpus grows past ~5000.
- Migrating existing JSON corpus contents *out* of the JSON file. The JSON remains as the bootstrap seed source.

## Files touched

```
migrations/
  0004_corpus_submission_status.sql        (new)

functions/
  _lib/
    corpus-id.js                            (new — moved + JS-ESM version of scripts/corpus-id.mjs)
    config.js                               (modified — add submit limits + admin section)
  api/
    generate.js                             (modified — add status='approved' filter to fetchCorpusRows)
    corpus/
      list.js                               (new)
      submit.js                             (new)
    admin/
      approve.js                            (new)

scripts/
  corpus-id.mjs                             (modified — re-export from functions/_lib/corpus-id.js)

public/
  index.html                                (modified — add tab nav + new sections + footer admin link)
  styles.css                                (modified — tabs, tables, form, toast, admin-page rules)
  config.js                                 (modified — submit constants)
  app.js                                    (modified — tab switcher; existing generator code preserved)
  corpus.js                                 (new)
  submit.js                                 (new)
  admin.html                                (new)
  admin.js                                  (new)

package.json                                (modified — `check` script syntax-checks new JS files)
wrangler.toml                               (no change — ADMIN_TOKEN goes via `wrangler secret put`)
README.md / README.zh-CN.md                 (modified — point contributors to the website; PR-flow demoted to "advanced")
```
