# Corpus Browse, Submission & Admin Approval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a browse-and-search corpus tab, a public submission tab that lands rows in a `pending` queue, and a token-gated admin page that approves pending rows (embed → upsert into Vectorize → mark approved) or deletes them.

**Architecture:** Three SPA tabs on `/` (生成 / 语料 / 投稿) plus a separate `/admin` page protected by an `ADMIN_TOKEN` secret. Three new Pages Functions: `/api/corpus/list`, `/api/corpus/submit`, `/api/admin/approve`. One additive D1 migration. Existing seed rows default to `status='approved'` so RAG keeps working unchanged.

**Tech Stack:** Cloudflare Pages Functions (ES modules), D1 (sqlite), Vectorize, Workers AI (`@cf/baai/bge-m3`), KV (rate-limit), plain HTML/CSS/JS frontend (no bundler, classic `<script>` tags).

**Spec:** `docs/superpowers/specs/2026-05-28-corpus-browse-and-submission-design.md`

**Verification note:** this repo has no test harness (`npm run check` is just `node --check` across every JS file). Each task is verified by `npm run check` + curl probes against `npm run dev` + browser smoke checks where relevant. Tests are not added.

---

## File Structure

**New files**
- `migrations/0004_corpus_submission_status.sql`
- `functions/_lib/corpus-id.js`
- `functions/api/corpus/list.js`
- `functions/api/corpus/submit.js`
- `functions/api/admin/approve.js`
- `public/corpus.js`
- `public/submit.js`
- `public/admin.html`
- `public/admin.js`

**Modified files**
- `functions/_lib/config.js` (add `corpus` + `submitRateLimit` sections)
- `functions/api/generate.js` (defensive `status='approved'` filter in `fetchCorpusRows`)
- `public/index.html` (tab nav + tab panels + new `<script>` tags + admin link)
- `public/config.js` (corpus + admin constants)
- `public/app.js` (tab switcher)
- `public/styles.css` (tab, pill, corpus card, submit card, queue, toast styles)
- `package.json` (extend `check` script)
- `README.md`, `README.zh-CN.md` (demote PR-flow, point to website)

**Untouched**
- `scripts/corpus-id.mjs` stays sync (uses `node:crypto`). The Worker mirror in `functions/_lib/corpus-id.js` is async (uses Web Crypto `subtle.digest`). Both produce identical `v50_<sha12(text)>` ids — a comment in each file points to the other and notes the invariant.

---

## Task 1: Add the migration

**Files:**
- Create: `migrations/0004_corpus_submission_status.sql`

- [ ] **Step 1: Write the migration SQL**

Create `migrations/0004_corpus_submission_status.sql` with:

```sql
ALTER TABLE corpus_items ADD COLUMN status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE corpus_items ADD COLUMN submitted_at TEXT;
ALTER TABLE corpus_items ADD COLUMN approved_at TEXT;

CREATE INDEX IF NOT EXISTS idx_corpus_items_status
  ON corpus_items (status, created_at);
```

- [ ] **Step 2: Apply the migration locally**

Run: `npm run migrate:local`

Expected: a row like `🌀 Mapping SQL input into an array of statements` followed by `✔ Successfully ran migration` and a count of statements (3 ALTERs + 1 CREATE INDEX).

- [ ] **Step 3: Verify schema**

Run: `npx wrangler d1 execute v50-db --local --command "PRAGMA table_info(corpus_items);"`

Expected: output table includes new rows for `status` (default `'approved'`, notnull=1), `submitted_at` (notnull=0), `approved_at` (notnull=0).

- [ ] **Step 4: Verify existing data is preserved**

Run: `npx wrangler d1 execute v50-db --local --command "SELECT status, COUNT(*) FROM corpus_items GROUP BY status;"`

Expected: every existing row reports `status='approved'`. No `NULL`.

- [ ] **Step 5: Commit**

```bash
git add migrations/0004_corpus_submission_status.sql
git commit -m "Add status/submitted_at/approved_at columns to corpus_items"
```

---

## Task 2: Worker-side `resolveCorpusId` helper

**Files:**
- Create: `functions/_lib/corpus-id.js`

- [ ] **Step 1: Write the helper**

Create `functions/_lib/corpus-id.js` with:

```js
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
```

- [ ] **Step 2: Add a back-reference comment to the Node helper**

Edit `scripts/corpus-id.mjs`. Replace the existing top comment block (lines 1–7) with:

```js
import { createHash } from 'node:crypto';

// Node-side corpus id helper used by scripts/import-corpus.mjs and
// scripts/index-corpus.mjs. The Worker runtime uses an async sibling at
// functions/_lib/corpus-id.js — both MUST produce identical
// v50_<sha12(text)> ids, since D1 rows and Vectorize entries share the
// same id and any drift would silently break retrieval.
```

(Leave the function body unchanged.)

- [ ] **Step 3: Syntax check**

Run: `node --check functions/_lib/corpus-id.js && node --check scripts/corpus-id.mjs`

Expected: no output, exit 0.

- [ ] **Step 4: Verify both produce the same id**

Run:

```bash
node --input-type=module -e "
  const { resolveCorpusId: asyncFn } = await import('./functions/_lib/corpus-id.js');
  const { resolveCorpusId: syncFn } = await import('./scripts/corpus-id.mjs');
  const text = '今天 V 我 50，给我多发一份咸蛋黄炸鸡。';
  const a = await asyncFn({ text });
  const b = syncFn({ text });
  console.log(a, b, a === b ? 'MATCH' : 'MISMATCH');
"
```

Expected: two identical `v50_<12hex>` ids and `MATCH`.

- [ ] **Step 5: Commit**

```bash
git add functions/_lib/corpus-id.js scripts/corpus-id.mjs
git commit -m "Add worker-side resolveCorpusId helper"
```

---

## Task 3: Defensive `status='approved'` filter in generate.js

**Files:**
- Modify: `functions/api/generate.js` — `fetchCorpusRows` function (currently around line 252)

- [ ] **Step 1: Patch fetchCorpusRows**

Find this block:

```js
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT id, text, author, source_url FROM corpus_items WHERE id IN (${placeholders})`)
    .bind(...uniqueIds)
    .all();
```

Replace with:

```js
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT id, text, author, source_url FROM corpus_items
        WHERE id IN (${placeholders})
          AND status = 'approved'`
    )
    .bind(...uniqueIds)
    .all();
```

- [ ] **Step 2: Syntax check**

Run: `node --check functions/api/generate.js`

Expected: exit 0.

- [ ] **Step 3: Smoke-test existing generation still works**

Start dev: `npm run dev` (leave running in a separate terminal).

Run in another terminal:

```bash
curl -s -X POST http://localhost:8788/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"keywords":"加班"}' | head -c 400
```

Expected: `{"ok":true,"text":"...","attempt_no":0,"reference_ids":["v50_...",...],"source":"rag",...}`. `reference_ids` must be non-empty (RAG still finds seed rows because they're `status='approved'`).

- [ ] **Step 4: Commit**

```bash
git add functions/api/generate.js
git commit -m "Filter fetchCorpusRows to status='approved' as defense in depth"
```

---

## Task 4: Backend config additions

**Files:**
- Modify: `functions/_lib/config.js`

- [ ] **Step 1: Replace the file**

Overwrite `functions/_lib/config.js` with:

```js
// Backend tuning knobs. Underscore-prefixed dir is non-routable in Pages.
// Mirror `input.keywordLimit` and the user-facing message strings in
// public/config.js, which the browser loads as a classic script.

export const CONFIG = {
  ai: {
    chatModel: '@cf/moonshotai/kimi-k2.6',
    embeddingModel: '@cf/baai/bge-m3',
    maxCompletionTokens: 520,
    defaultQuery: '周四 V我50',
    gatewayId: 'default',
    temperature: { initial: 0.9, regen: 0.95, deepSearch: 1 }
  },
  retrieval: {
    referenceLimit: 6,
    topK: { standard: 30, deepSearch: 50 },
    mmrLambda: { focused: 0.75, balanced: 0.55, diverse: 0.45 },
    attemptThresholds: { reuseMax: 2, deepSearch: 3, maxDiversity: 4 }
  },
  input: {
    keywordLimit: 40,
    copyTextLimit: 500,
    previousOutputsLimit: 5,
    previousOutputItemLimit: 360,
    usedReferenceIdsLimit: 80,
    usedReferenceIdItemLimit: 120
  },
  rateLimit: {
    minutely: 10,
    daily: 40,
    minuteBucketTtlSeconds: 90,
    dayBucketTtlSeconds: 90000
  },
  corpus: {
    submitTextMin: 20,
    submitTextMax: 180,
    submitAuthorMax: 40,
    submitDefaultAuthor: '匿名',
    listSearchQueryMax: 60,
    listPageSizeMin: 10,
    listPageSizeMax: 50,
    listPageSizeDefault: 20
  },
  submitRateLimit: {
    daily: 5,
    dayBucketTtlSeconds: 90000
  }
};
```

- [ ] **Step 2: Syntax check**

Run: `node --check functions/_lib/config.js`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add functions/_lib/config.js
git commit -m "Add corpus + submitRateLimit config sections"
```

---

## Task 5: Frontend config additions

**Files:**
- Modify: `public/config.js`

- [ ] **Step 1: Replace the file**

Overwrite `public/config.js` with:

```js
// Frontend tuning knobs. Loaded as a classic <script> before app.js so
// it works under file:// (ESM imports are blocked from file:// origins).
// Keep `input.keywordLimit` and `input.previousOutputsLimit` in sync with
// functions/_lib/config.js — the backend clamps requests to the same values.

window.V50_CONFIG = {
  input: {
    keywordLimit: 40,
    previousOutputsLimit: 5,
    maxTrackedReferenceIds: 60
  },
  ui: {
    maxHistory: 5,
    copyFeedbackTimeoutMs: 1400,
    messages: {
      apiError: '生成失败，请稍后再试',
      rateLimit: '请求太频繁，请稍后再试',
      quotaExhausted: '今日生成量已用尽，请明天再试'
    }
  },
  corpus: {
    pageSize: 20,
    submitTextMin: 20,
    submitTextMax: 180,
    submitAuthorMax: 40,
    submitDefaultAuthor: '匿名',
    searchQueryMax: 60,
    toastTimeoutMs: 3200,
    statusLabels: {
      approved: '已收录',
      pending: '待审核'
    },
    messages: {
      submitSuccess: '投稿成功，等待审核',
      submitDuplicateApproved: '这条已经在语料库里了',
      submitDuplicatePending: '这条已在投稿队列中，等待审核',
      submitRateLimit: '今日投稿次数已达上限',
      submitTooShort: '至少 20 个字',
      submitTooLong: '不能超过 180 个字',
      submitGenericError: '投稿失败，请稍后再试',
      browseError: '加载失败，请稍后再试'
    }
  },
  admin: {
    tokenStorageKey: 'v50-admin-token',
    pageSize: 30,
    toastTimeoutMs: 2800,
    messages: {
      unauthorized: '验证失败，请检查 token',
      generic: '操作失败，请稍后再试',
      embedFailed: '索引失败，请稍后再试',
      approved: '已通过',
      deleted: '已删除'
    }
  }
};
```

- [ ] **Step 2: Syntax check**

Run: `node --check public/config.js`

Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add public/config.js
git commit -m "Add corpus + admin frontend config"
```

---

## Task 6: `/api/corpus/list` endpoint

**Files:**
- Create: `functions/api/corpus/list.js`

- [ ] **Step 1: Create the function**

Create the file (and parent dir) with:

```js
// POST /api/corpus/list — paginated browse + LIKE search over corpus_items.
import { CONFIG } from '../../_lib/config.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
  }
  return handleList(context);
}

async function handleList(context) {
  const { request, env } = context;

  try {
    if (!env.DB) return json({ ok: false, error: 'Corpus listing is not configured' }, 503);

    const payload = await readJson(request);
    const input = normalizeInput(payload);

    const filters = [];
    const args = [];

    if (input.status !== 'all') {
      filters.push('status = ?');
      args.push(input.status);
    }

    if (input.q) {
      filters.push("text LIKE ? ESCAPE '\\\\'");
      args.push(`%${escapeLike(input.q)}%`);
    }

    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const orderBy = input.status === 'pending'
      ? 'submitted_at ASC, created_at ASC'
      : 'created_at DESC';
    const offset = (input.page - 1) * input.page_size;

    const countStmt = env.DB
      .prepare(`SELECT COUNT(*) AS total FROM corpus_items ${where}`)
      .bind(...args);
    const listStmt = env.DB
      .prepare(
        `SELECT id, text, author, source_url, status, created_at, submitted_at, approved_at
           FROM corpus_items
           ${where}
           ORDER BY ${orderBy}
           LIMIT ? OFFSET ?`
      )
      .bind(...args, input.page_size, offset);

    const [countResult, listResult] = await Promise.all([countStmt.first(), listStmt.all()]);
    const total = Number(countResult?.total ?? 0);
    const items = Array.isArray(listResult?.results) ? listResult.results : [];

    return json({
      ok: true,
      items,
      total,
      page: input.page,
      page_size: input.page_size
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('Corpus list failed', error);
    return json({ ok: false, error: 'Corpus list failed' }, 500);
  }
}

function normalizeInput(payload) {
  const { corpus: cfg } = CONFIG;
  const q = typeof payload?.q === 'string' ? payload.q.trim().slice(0, cfg.listSearchQueryMax) : '';
  const rawStatus = typeof payload?.status === 'string' ? payload.status.trim().toLowerCase() : '';
  const status = rawStatus === 'pending' || rawStatus === 'all' ? rawStatus : 'approved';

  const rawPage = Number.isInteger(payload?.page) ? payload.page : 1;
  const page = Math.max(rawPage, 1);

  const rawPageSize = Number.isInteger(payload?.page_size) ? payload.page_size : cfg.listPageSizeDefault;
  const page_size = Math.min(Math.max(rawPageSize, cfg.listPageSizeMin), cfg.listPageSizeMax);

  return { q, status, page, page_size };
}

function escapeLike(value) {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw json({ ok: false, error: 'Content-Type must be application/json' }, 415);
  }
  try {
    return await request.json();
  } catch {
    throw json({ ok: false, error: 'Invalid JSON' }, 400);
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...headers
    }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check functions/api/corpus/list.js`

Expected: exit 0.

- [ ] **Step 3: Probe defaults**

With `npm run dev` running:

```bash
curl -s -X POST http://localhost:8788/api/corpus/list \
  -H 'Content-Type: application/json' \
  -d '{}' | head -c 400
```

Expected: `{"ok":true,"items":[{...}],"total":<n>,"page":1,"page_size":20}` with seed rows. `total` matches the corpus size.

- [ ] **Step 4: Probe pending filter**

```bash
curl -s -X POST http://localhost:8788/api/corpus/list \
  -H 'Content-Type: application/json' \
  -d '{"status":"pending"}'
```

Expected: `{"ok":true,"items":[],"total":0,"page":1,"page_size":20}` (no pending rows yet).

- [ ] **Step 5: Probe search**

```bash
curl -s -X POST http://localhost:8788/api/corpus/list \
  -H 'Content-Type: application/json' \
  -d '{"q":"周四","page_size":5}'
```

Expected: items whose `text` includes "周四"; `page_size` is `5`.

- [ ] **Step 6: Commit**

```bash
git add functions/api/corpus/list.js
git commit -m "Add /api/corpus/list endpoint"
```

---

## Task 7: Tab nav scaffolding

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

- [ ] **Step 1: Add the tab nav and wrap existing content**

Edit `public/index.html`. Replace the contents of `<header class="topbar" ...>` (lines 10–28) with:

```html
    <header class="topbar" aria-label="站点导航">
      <a class="topbar-brand" href="/" aria-label="V我50 文案机首页">
        <span class="brand-mark">V</span>
        <span>V我50 文案机</span>
      </a>
      <nav class="tab-nav" aria-label="主导航">
        <button class="tab-link active" data-tab="generate" type="button">生成</button>
        <button class="tab-link" data-tab="corpus" type="button">语料</button>
        <button class="tab-link" data-tab="submit" type="button">投稿</button>
      </nav>
      <a
        class="repo-link"
        href="https://github.com/reporkey/v50"
        target="_blank"
        rel="noreferrer"
        aria-label="打开 GitHub 仓库"
        title="GitHub"
      >
        <svg class="repo-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
          <path d="M9 18c-4.51 2-5-2-7-2" />
        </svg>
      </a>
    </header>
```

Then wrap the existing two `<section>`s inside `<main class="app">` into three `<section class="tab-panel">` containers. Replace lines starting from `<main class="app">` through `</main>` with:

```html
    <main class="app">
      <div class="tab-panel" data-tab-panel="generate">
        <section class="generator-card">
          <div class="hero-strip" aria-hidden="true">
            <span class="stripe"></span>
            <span class="stripe wide"></span>
            <span class="stripe"></span>
          </div>

          <header class="hero">
            <div>
              <h1 class="art-title" aria-label="V我50 文案机">
                <span class="title-main">V我50</span>
                <span class="title-sub">文案机</span>
              </h1>
            </div>
            <div class="food-mark" aria-hidden="true">
              <img src="assets/food-combo.png" alt="" />
            </div>
          </header>

          <div class="controls">
            <div class="field">
              <label for="keywords">关键词（可选）</label>
              <input id="keywords" type="text" placeholder="例如：加班、ddl、恋爱脑" />
            </div>

            <div class="button-row">
              <button id="generateBtn" class="btn primary" type="button">生成文案</button>
            </div>
          </div>

          <section class="result-wrap" aria-live="polite">
            <div class="result-head">
              <div>
                <p class="section-kicker">今日小票</p>
                <h2>当前文案</h2>
              </div>
              <button id="copyBtn" class="copy-btn">复制</button>
            </div>
            <p id="resultText" class="result-text">点击“生成文案”，领取你今天的 V50 文学。</p>
            <p id="copyFeedback" class="copy-feedback" aria-live="polite"></p>
          </section>
        </section>

        <section class="history-card">
          <div class="history-head">
            <div>
              <p class="section-kicker">灵感回收站</p>
              <h2>最近 5 条</h2>
            </div>
            <button id="clearHistoryBtn" class="text-btn subtle">清空</button>
          </div>
          <ul id="historyList" class="history-list">
            <li class="empty">暂无历史，先生成一条试试。</li>
          </ul>
        </section>
      </div>

      <div class="tab-panel hidden" data-tab-panel="corpus">
        <!-- populated by corpus.js (Task 8) -->
      </div>

      <div class="tab-panel hidden" data-tab-panel="submit">
        <!-- populated by submit.js (Task 10) -->
      </div>
    </main>
```

(The generator + history cards keep their existing markup; only their wrapper changes.)

- [ ] **Step 2: Add the tab switcher to app.js**

Edit `public/app.js`. At the bottom of the file (after `renderHistory(loadHistory());`), append:

```js
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-link');
  const panels = document.querySelectorAll('.tab-panel');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t === tab));
      panels.forEach((p) => p.classList.toggle('hidden', p.dataset.tabPanel !== target));
      document.dispatchEvent(new CustomEvent('v50:tabchange', { detail: { tab: target } }));
    });
  });
}

setupTabs();
```

- [ ] **Step 3: Add tab CSS**

Edit `public/styles.css`. Find the existing `.topbar { ... }` rule (~line 51). After the `.topbar-brand` and `.brand-mark` block (line 84), insert:

```css
.tab-nav {
  display: flex;
  gap: 6px;
  flex: 1 1 auto;
  justify-content: center;
  flex-wrap: wrap;
}

.tab-link {
  border: 1px solid rgba(117, 58, 29, 0.18);
  border-radius: 8px;
  padding: 6px 14px;
  background: rgba(255, 255, 255, 0.82);
  color: #5b2b20;
  font-weight: 800;
  font-size: 14px;
  transition: transform 160ms ease, background 160ms ease, color 160ms ease;
}

.tab-link:hover {
  transform: translateY(-1px);
}

.tab-link.active {
  background: var(--red);
  color: #fff;
  border-color: var(--red-dark);
  box-shadow: 0 4px 0 var(--red-dark);
}

.tab-panel.hidden {
  /* !important wins over the later .tab-panel[data-tab-panel="generate"]
     display rule when the generate panel is hidden. */
  display: none !important;
}
```

Also: in the existing media query `@media (min-width: 760px) { .app { grid-template-columns: ... } ... }`, change it so the grid only applies to the generate panel. Replace the existing block:

```css
@media (min-width: 760px) {
  .app {
    grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr);
    padding: 14px 0 12px;
  }

  .generator-card,
  .history-card {
    min-height: 620px;
  }

  .style-options {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

}
```

with:

```css
@media (min-width: 760px) {
  .tab-panel[data-tab-panel="generate"] {
    display: grid;
    gap: 14px;
    grid-template-columns: minmax(0, 1.25fr) minmax(320px, 0.75fr);
  }

  .tab-panel[data-tab-panel="generate"] .generator-card,
  .tab-panel[data-tab-panel="generate"] .history-card {
    min-height: 620px;
  }

  .style-options {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
```

This moves the two-column layout from `.app` (which now holds three tab panels) onto only the active generate panel, so the corpus and submit panels can use their own layouts.

Additionally, since `.app` was previously `display: grid` (line 89), change:

```css
.app {
  flex: 1 0 auto;
  padding: 14px 0 12px;
  display: grid;
  gap: 14px;
  align-items: stretch;
}
```

to:

```css
.app {
  flex: 1 0 auto;
  padding: 14px 0 12px;
  display: block;
}

.tab-panel[data-tab-panel="generate"] {
  display: grid;
  gap: 14px;
  align-items: stretch;
}
```

- [ ] **Step 4: Smoke test in browser**

With `npm run dev` running, open `http://localhost:8788/` in a browser.

Expected:
- Topbar shows brand on the left, three tab buttons in the middle (`生成` active, `语料`, `投稿`), GitHub icon on the right.
- The default view still shows the generator + history cards.
- Clicking `语料` hides the generator, shows an empty panel placeholder.
- Clicking `投稿` shows the other empty panel.
- Clicking `生成` returns to the generator. No console errors.

- [ ] **Step 5: Verify generation still works after the layout change**

In the `生成` tab, type a keyword, click 生成文案, verify text appears. Click 复制, see "已复制".

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/app.js public/styles.css
git commit -m "Add tab navigation scaffolding"
```

---

## Task 8: Browse tab UI

**Files:**
- Modify: `public/index.html` (populate corpus tab panel, add script tag)
- Create: `public/corpus.js`
- Modify: `public/styles.css` (corpus styles)

- [ ] **Step 1: Populate the corpus tab panel**

Edit `public/index.html`. Replace `<div class="tab-panel hidden" data-tab-panel="corpus">` and its placeholder comment with:

```html
      <div class="tab-panel hidden" data-tab-panel="corpus">
        <section class="corpus-card">
          <header class="corpus-head">
            <div>
              <p class="section-kicker">语料库</p>
              <h2>浏览与搜索</h2>
            </div>
          </header>

          <div class="corpus-controls">
            <input id="corpusSearch" type="text" placeholder="搜索文案..." maxlength="60" />
            <div class="filter-pills" role="tablist" aria-label="状态筛选">
              <button class="pill active" data-status="approved" type="button">已收录</button>
              <button class="pill" data-status="pending" type="button">待审核</button>
              <button class="pill" data-status="all" type="button">全部</button>
            </div>
          </div>

          <ul id="corpusList" class="corpus-list" aria-live="polite">
            <li class="empty">点击 “语料” 加载列表。</li>
          </ul>

          <footer class="corpus-foot">
            <button id="corpusPrev" class="btn ghost" type="button" disabled>上一页</button>
            <span id="corpusPageInfo" class="page-info">第 1 页 / 共 1 页</span>
            <button id="corpusNext" class="btn ghost" type="button" disabled>下一页</button>
          </footer>
        </section>
      </div>
```

Also: just before `</body>`, after `<script src="app.js"></script>`, add:

```html
    <script src="corpus.js"></script>
```

- [ ] **Step 2: Create corpus.js**

Create `public/corpus.js` with:

```js
const CORPUS_CONFIG = window.V50_CONFIG.corpus;

const searchEl = document.getElementById('corpusSearch');
const pillsEl = document.querySelectorAll('.corpus-card .pill');
const listEl = document.getElementById('corpusList');
const prevBtn = document.getElementById('corpusPrev');
const nextBtn = document.getElementById('corpusNext');
const pageInfoEl = document.getElementById('corpusPageInfo');

const state = {
  q: '',
  status: 'approved',
  page: 1,
  pageSize: CORPUS_CONFIG.pageSize,
  total: 0,
  loading: false,
  loaded: false
};

let searchDebounceTimer = null;

async function loadPage() {
  if (state.loading) return;
  state.loading = true;
  listEl.innerHTML = '<li class="empty">加载中...</li>';

  try {
    const response = await fetch('/api/corpus/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: state.q,
        status: state.status,
        page: state.page,
        page_size: state.pageSize
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error('list failed');
    renderList(payload.items, payload.total);
  } catch (error) {
    console.error(error);
    listEl.innerHTML = `<li class="empty">${CORPUS_CONFIG.messages.browseError}</li>`;
  } finally {
    state.loading = false;
    state.loaded = true;
  }
}

function renderList(items, total) {
  state.total = total;
  if (!items || items.length === 0) {
    listEl.innerHTML = '<li class="empty">这里还什么都没有。</li>';
  } else {
    listEl.innerHTML = '';
    items.forEach((item) => listEl.append(renderItem(item)));
  }
  updatePager();
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = `corpus-item status-${item.status}`;

  const text = document.createElement('p');
  text.className = 'corpus-text';
  text.textContent = item.text;

  const meta = document.createElement('p');
  meta.className = 'corpus-meta';
  const author = document.createElement('span');
  author.className = 'corpus-author';
  author.textContent = item.author || CORPUS_CONFIG.submitDefaultAuthor;
  const status = document.createElement('span');
  status.className = `corpus-status corpus-status-${item.status}`;
  status.textContent = CORPUS_CONFIG.statusLabels[item.status] || item.status;
  meta.append(author, status);

  li.append(text, meta);
  return li;
}

function updatePager() {
  const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
  pageInfoEl.textContent = `第 ${state.page} 页 / 共 ${totalPages} 页`;
  prevBtn.disabled = state.page <= 1;
  nextBtn.disabled = state.page >= totalPages;
}

function selectStatus(status) {
  if (state.status === status) return;
  state.status = status;
  state.page = 1;
  pillsEl.forEach((pill) => pill.classList.toggle('active', pill.dataset.status === status));
  loadPage();
}

function onSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const next = searchEl.value.trim();
    if (next === state.q) return;
    state.q = next;
    state.page = 1;
    loadPage();
  }, 260);
}

prevBtn.addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    loadPage();
  }
});
nextBtn.addEventListener('click', () => {
  const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
  if (state.page < totalPages) {
    state.page += 1;
    loadPage();
  }
});
pillsEl.forEach((pill) => {
  pill.addEventListener('click', () => selectStatus(pill.dataset.status));
});
searchEl.addEventListener('input', onSearchInput);

document.addEventListener('v50:tabchange', (event) => {
  if (event.detail?.tab === 'corpus' && !state.loaded) {
    loadPage();
  }
});

window.V50_CORPUS_RELOAD = () => {
  state.page = 1;
  loadPage();
};
```

- [ ] **Step 3: Add corpus CSS**

Edit `public/styles.css`. Append at the very end (after the existing `@media (max-width: 520px)` block):

```css
.corpus-card,
.submit-card {
  position: relative;
  overflow: hidden;
  padding: 18px;
  border: 1px solid rgba(117, 58, 29, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: var(--shadow);
}

.corpus-head,
.submit-head {
  margin-bottom: 14px;
}

.corpus-controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}

.corpus-controls input {
  min-height: 44px;
}

.filter-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.pill {
  min-height: 36px;
  padding: 4px 14px;
  border: 1px solid rgba(117, 58, 29, 0.18);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.82);
  color: #5b2b20;
  font-weight: 800;
  font-size: 13px;
  transition: transform 160ms ease, background 160ms ease, color 160ms ease;
}

.pill:hover {
  transform: translateY(-1px);
}

.pill.active {
  background: var(--red);
  color: #fff;
  border-color: var(--red-dark);
}

.corpus-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.corpus-list .empty {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.6);
}

.corpus-item {
  position: relative;
  padding: 12px 14px;
  border: 1px solid #ead8c7;
  border-radius: 8px;
  background: #fffaf1;
}

.corpus-item.status-pending {
  background: #fff6df;
  border-color: #e6c870;
}

.corpus-text {
  margin: 0 0 6px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.corpus-meta {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.corpus-status {
  font-weight: 800;
}

.corpus-status-approved {
  color: var(--green);
}

.corpus-status-pending {
  color: #9a6b00;
}

.corpus-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

.page-info {
  font-size: 13px;
  color: var(--muted);
}

.btn.ghost {
  min-height: 40px;
  padding: 0 14px;
  border: 1px solid rgba(117, 58, 29, 0.22);
  background: rgba(255, 255, 255, 0.86);
  color: #5b2b20;
  border-radius: 8px;
  font-weight: 800;
}

.btn.ghost:hover:not(:disabled) {
  transform: translateY(-1px);
}

.btn.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}
```

- [ ] **Step 4: Syntax check**

Run: `node --check public/corpus.js`

Expected: exit 0.

- [ ] **Step 5: Smoke test in browser**

Reload `http://localhost:8788/`, click `语料` tab.

Expected:
- List loads with approved seed rows; each shows text, author, and "已收录" badge.
- Pager footer shows e.g. "第 1 页 / 共 5 页" depending on corpus size.
- Click 下一页 → page 2 loads.
- Type "周四" in search → after ~260ms the list filters to matches, page resets to 1.
- Click 待审核 pill → list is empty ("这里还什么都没有。"). Active style moves to that pill.
- Click 已收录 → back to seed rows.

- [ ] **Step 6: Commit**

```bash
git add public/index.html public/corpus.js public/styles.css
git commit -m "Add corpus browse tab"
```

---

## Task 9: `/api/corpus/submit` endpoint

**Files:**
- Create: `functions/api/corpus/submit.js`

- [ ] **Step 1: Create the function**

Create `functions/api/corpus/submit.js` with:

```js
// POST /api/corpus/submit — create a pending corpus row from a public
// submission. Hard-rejects duplicates with 409 (no silent dedupe).
import { CONFIG } from '../../_lib/config.js';
import { resolveCorpusId } from '../../_lib/corpus-id.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
  }
  return handleSubmit(context);
}

async function handleSubmit(context) {
  const { request, env } = context;

  try {
    if (!env.DB) return json({ ok: false, error: 'Submission service is not configured' }, 503);

    const ip = getClientIp(request);
    const limited =
      !isLocalDevRequest(request) && (await isSubmitRateLimited(env.RATE_LIMIT, ip));
    if (limited) {
      return json({ ok: false, error: '今日投稿次数已达上限' }, 429);
    }

    const payload = await readJson(request);
    const input = normalizeInput(payload);
    const id = await resolveCorpusId({ text: input.text });

    const existing = await env.DB
      .prepare('SELECT status FROM corpus_items WHERE id = ?')
      .bind(id)
      .first();
    if (existing) {
      return json({ ok: false, error: 'duplicate', existing_status: existing.status }, 409);
    }

    await env.DB
      .prepare(
        `INSERT INTO corpus_items (id, text, author, source_url, status, submitted_at)
           VALUES (?, ?, ?, NULL, 'pending', CURRENT_TIMESTAMP)`
      )
      .bind(id, input.text, input.author)
      .run();

    return json({ ok: true, id, status: 'pending' }, 201);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('Corpus submission failed', error);
    return json({ ok: false, error: '投稿失败，请稍后再试' }, 500);
  }
}

function normalizeInput(payload) {
  const { corpus: cfg } = CONFIG;
  const rawText = typeof payload?.text === 'string' ? payload.text.trim() : '';
  const rawAuthor = typeof payload?.author === 'string' ? payload.author.trim() : '';

  if (!rawText) {
    throw json({ ok: false, error: 'text_required' }, 400);
  }
  if (rawText.length < cfg.submitTextMin || rawText.length > cfg.submitTextMax) {
    throw json({ ok: false, error: 'text_length' }, 400);
  }
  if (rawAuthor.length > cfg.submitAuthorMax) {
    throw json({ ok: false, error: 'author_length' }, 400);
  }

  return {
    text: rawText,
    author: rawAuthor || cfg.submitDefaultAuthor
  };
}

async function isSubmitRateLimited(kv, ip) {
  if (!kv) return false;
  const { daily, dayBucketTtlSeconds } = CONFIG.submitRateLimit;
  const dayBucket = new Date(Date.now()).toISOString().slice(0, 10);
  const key = `submit:${ip}:d:${dayBucket}`;
  const current = Number((await kv.get(key)) || '0');
  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl: dayBucketTtlSeconds });
  return next > daily;
}

function isLocalDevRequest(request) {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw json({ ok: false, error: 'Content-Type must be application/json' }, 415);
  }
  try {
    return await request.json();
  } catch {
    throw json({ ok: false, error: 'Invalid JSON' }, 400);
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...headers
    }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check functions/api/corpus/submit.js`

Expected: exit 0.

- [ ] **Step 3: Probe successful submit**

With `npm run dev` running:

```bash
curl -s -X POST http://localhost:8788/api/corpus/submit \
  -H 'Content-Type: application/json' \
  -d '{"text":"周四进度条还没走完，钱包先走完了，群里随便挑一个 V 我 50 我帮大家分担情绪","author":"qa"}'
```

Expected: `{"ok":true,"id":"v50_<12hex>","status":"pending"}`. Note the id for the next step.

- [ ] **Step 4: Probe duplicate**

```bash
curl -i -s -X POST http://localhost:8788/api/corpus/submit \
  -H 'Content-Type: application/json' \
  -d '{"text":"周四进度条还没走完，钱包先走完了，群里随便挑一个 V 我 50 我帮大家分担情绪","author":"qa"}' | head -20
```

Expected: status `409 Conflict`, body `{"ok":false,"error":"duplicate","existing_status":"pending"}`.

- [ ] **Step 5: Probe too short**

```bash
curl -i -s -X POST http://localhost:8788/api/corpus/submit \
  -H 'Content-Type: application/json' \
  -d '{"text":"短文"}' | head -20
```

Expected: status `400`, body `{"ok":false,"error":"text_length"}`.

- [ ] **Step 6: Probe via the list endpoint**

```bash
curl -s -X POST http://localhost:8788/api/corpus/list \
  -H 'Content-Type: application/json' \
  -d '{"status":"pending"}'
```

Expected: `items` contains the row just inserted, `total: 1`.

- [ ] **Step 7: Commit**

```bash
git add functions/api/corpus/submit.js
git commit -m "Add /api/corpus/submit endpoint"
```

---

## Task 10: Submit tab UI

**Files:**
- Modify: `public/index.html` (populate submit panel, add script + toast host)
- Create: `public/submit.js`
- Modify: `public/styles.css` (form + toast styles)

- [ ] **Step 1: Populate the submit panel and add toast host**

Edit `public/index.html`. Replace `<div class="tab-panel hidden" data-tab-panel="submit">` and its placeholder comment with:

```html
      <div class="tab-panel hidden" data-tab-panel="submit">
        <section class="submit-card">
          <header class="submit-head">
            <p class="section-kicker">投稿</p>
            <h2>提交一条 V50 文案</h2>
            <p class="submit-help">写一条 20-180 字的 V我50 文案。通过审核后会进入语料库，被生成器引用。</p>
          </header>
          <form id="submitForm" class="submit-form">
            <div class="field">
              <label for="submitText">文案</label>
              <textarea id="submitText" rows="5" maxlength="180" placeholder="把脑洞写下来..." required></textarea>
              <span class="char-counter"><span id="submitCounter">0</span> / 180</span>
            </div>
            <div class="field">
              <label for="submitAuthor">作者 / 来源（可选）</label>
              <input id="submitAuthor" type="text" maxlength="40" placeholder="留空则记作 匿名" />
            </div>
            <div class="button-row">
              <button id="submitBtn" class="btn primary" type="submit" disabled>提交投稿</button>
            </div>
          </form>
        </section>
      </div>
```

Then just before the closing `</body>` tag, after the `<footer class="site-footer">...</footer>`, add:

```html
    <div id="toastHost" class="toast-host" aria-live="polite"></div>
```

Then add the script tag for `submit.js`, after the `<script src="corpus.js"></script>` line:

```html
    <script src="submit.js"></script>
```

- [ ] **Step 2: Create submit.js**

Create `public/submit.js` with:

```js
const SUBMIT_CONFIG = window.V50_CONFIG.corpus;

const submitForm = document.getElementById('submitForm');
const textEl = document.getElementById('submitText');
const authorEl = document.getElementById('submitAuthor');
const submitBtn = document.getElementById('submitBtn');
const counterEl = document.getElementById('submitCounter');
const toastHost = document.getElementById('toastHost');

let submitting = false;

function updateState() {
  const length = textEl.value.trim().length;
  counterEl.textContent = String(length);
  submitBtn.disabled =
    submitting ||
    length < SUBMIT_CONFIG.submitTextMin ||
    length > SUBMIT_CONFIG.submitTextMax;
}

function showToast(message, kind) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind || 'info'}`;
  toast.textContent = message;
  toastHost.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, SUBMIT_CONFIG.toastTimeoutMs);
}

async function handleSubmit(event) {
  event.preventDefault();
  if (submitting) return;
  const text = textEl.value.trim();
  const author = authorEl.value.trim();

  submitting = true;
  updateState();
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = '提交中...';

  try {
    const response = await fetch('/api/corpus/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author })
    });
    let payload = null;
    try { payload = await response.json(); } catch {}

    if (response.status === 201 && payload?.ok) {
      showToast(SUBMIT_CONFIG.messages.submitSuccess, 'success');
      textEl.value = '';
      authorEl.value = '';
      if (typeof window.V50_CORPUS_RELOAD === 'function') {
        window.V50_CORPUS_RELOAD();
      }
    } else if (response.status === 409 && payload?.error === 'duplicate') {
      const message =
        payload.existing_status === 'pending'
          ? SUBMIT_CONFIG.messages.submitDuplicatePending
          : SUBMIT_CONFIG.messages.submitDuplicateApproved;
      showToast(message, 'error');
    } else if (response.status === 429) {
      showToast(SUBMIT_CONFIG.messages.submitRateLimit, 'error');
    } else if (payload?.error === 'text_length') {
      const length = text.length;
      const message =
        length < SUBMIT_CONFIG.submitTextMin
          ? SUBMIT_CONFIG.messages.submitTooShort
          : SUBMIT_CONFIG.messages.submitTooLong;
      showToast(message, 'error');
    } else {
      showToast(SUBMIT_CONFIG.messages.submitGenericError, 'error');
    }
  } catch (error) {
    console.error(error);
    showToast(SUBMIT_CONFIG.messages.submitGenericError, 'error');
  } finally {
    submitting = false;
    submitBtn.textContent = originalLabel;
    updateState();
  }
}

submitForm.addEventListener('submit', handleSubmit);
textEl.addEventListener('input', updateState);
authorEl.addEventListener('input', updateState);

updateState();
```

- [ ] **Step 3: Add submit + toast CSS**

Edit `public/styles.css`. Append at the very end:

```css
.submit-help {
  margin: 6px 0 0;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
}

.submit-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.submit-form textarea {
  width: 100%;
  min-height: 132px;
  padding: 12px 13px;
  border: 2px solid var(--line);
  border-radius: 8px;
  background: #fff;
  color: var(--ink);
  font-family: inherit;
  font-size: 15px;
  line-height: 1.6;
  resize: vertical;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9);
}

.submit-form textarea:focus {
  outline: 3px solid rgba(255, 201, 64, 0.46);
  border-color: var(--yellow);
}

.char-counter {
  align-self: flex-end;
  font-size: 12px;
  color: var(--muted);
}

.toast-host {
  position: fixed;
  right: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 9999;
  pointer-events: none;
  max-width: min(340px, calc(100vw - 32px));
}

.toast {
  padding: 12px 14px;
  border-radius: 8px;
  background: #2d211b;
  color: #fff;
  font-weight: 800;
  font-size: 14px;
  line-height: 1.5;
  box-shadow: 0 10px 28px rgba(45, 33, 27, 0.32);
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 180ms ease, transform 180ms ease;
}

.toast.visible {
  opacity: 1;
  transform: translateY(0);
}

.toast-success {
  background: var(--green);
}

.toast-error {
  background: var(--red);
  box-shadow: 0 10px 28px rgba(215, 25, 32, 0.34);
}
```

- [ ] **Step 4: Syntax check**

Run: `node --check public/submit.js`

Expected: exit 0.

- [ ] **Step 5: Smoke test the happy path**

Reload `http://localhost:8788/`, click `投稿` tab.

Expected:
- Form shows. Submit button disabled (counter at 0/180).
- Type a 30-character string. Counter updates. Submit button enables.
- Click 提交投稿. Toast appears in the bottom-right: green "投稿成功，等待审核". Textarea clears.
- Click `语料` tab → click `待审核` pill. The newly submitted row appears.

- [ ] **Step 6: Smoke test the duplicate path**

Click `投稿` again, paste the same text you just submitted, click 提交投稿.

Expected: red toast "这条已在投稿队列中，等待审核". Textarea contents remain.

- [ ] **Step 7: Commit**

```bash
git add public/index.html public/submit.js public/styles.css
git commit -m "Add corpus submission tab"
```

---

## Task 11: `/api/admin/approve` endpoint

**Files:**
- Create: `functions/api/admin/approve.js`

- [ ] **Step 1: Create the function**

Create `functions/api/admin/approve.js` with:

```js
// POST /api/admin/approve — token-gated; approves a pending row by
// embedding its text and upserting into Vectorize, or deletes any row
// outright. The D1 UPDATE is last so a row is only marked 'approved'
// when its vector is queryable.
import { CONFIG } from '../../_lib/config.js';

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (context.request.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405, { Allow: 'POST, OPTIONS' });
  }
  return handleApprove(context);
}

async function handleApprove(context) {
  const { request, env } = context;
  const startedAt = performance.now();
  const timing = {};

  try {
    if (!env.ADMIN_TOKEN) {
      return json({ ok: false, error: 'admin_disabled' }, 503);
    }
    const provided = request.headers.get('X-Admin-Token') || '';
    if (!constantTimeEquals(provided, env.ADMIN_TOKEN)) {
      return json({ ok: false, error: 'unauthorized' }, 401);
    }
    if (!env.DB) return json({ ok: false, error: 'DB not configured' }, 503);

    const payload = await readJson(request);
    const action = typeof payload?.action === 'string' ? payload.action : '';
    const id = typeof payload?.id === 'string' ? payload.id.trim() : '';
    if (!id) return json({ ok: false, error: 'id_required' }, 400);

    if (action === 'approve') {
      return await doApprove(env, id, timing, startedAt);
    }
    if (action === 'delete') {
      return await doDelete(env, id, timing, startedAt);
    }
    return json({ ok: false, error: 'invalid_action' }, 400);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('Admin approve failed', error);
    timing.total_ms = elapsedMs(startedAt);
    return timedJson({ ok: false, error: 'internal_error' }, timing, 500);
  }
}

async function doApprove(env, id, timing, startedAt) {
  if (!env.AI || !env.V50_INDEX) {
    return json({ ok: false, error: 'AI/Vectorize not configured' }, 503);
  }

  const row = await measure(timing, 'lookup_ms', () =>
    env.DB.prepare('SELECT id, text, author, status FROM corpus_items WHERE id = ?').bind(id).first()
  );
  if (!row) return json({ ok: false, error: 'not_found' }, 404);
  if (row.status === 'approved') return json({ ok: false, error: 'already_approved' }, 409);

  let vector;
  try {
    vector = await measure(timing, 'embed_ms', () => embedText(env, row.text));
  } catch (error) {
    console.error('Embed failed', error);
    timing.total_ms = elapsedMs(startedAt);
    return timedJson({ ok: false, error: 'embed_failed' }, timing, 502);
  }

  try {
    await measure(timing, 'upsert_ms', () =>
      env.V50_INDEX.upsert([
        {
          id,
          values: vector,
          metadata: row.author ? { author: row.author } : {}
        }
      ])
    );
  } catch (error) {
    console.error('Vectorize upsert failed', error);
    timing.total_ms = elapsedMs(startedAt);
    return timedJson({ ok: false, error: 'upsert_failed' }, timing, 502);
  }

  await measure(timing, 'db_update_ms', () =>
    env.DB
      .prepare(
        `UPDATE corpus_items
            SET status = 'approved',
                approved_at = CURRENT_TIMESTAMP
          WHERE id = ?
            AND status = 'pending'`
      )
      .bind(id)
      .run()
  );

  timing.total_ms = elapsedMs(startedAt);
  return timedJson({ ok: true, id, status: 'approved' }, timing);
}

async function doDelete(env, id, timing, startedAt) {
  const row = await measure(timing, 'lookup_ms', () =>
    env.DB.prepare('SELECT id, status FROM corpus_items WHERE id = ?').bind(id).first()
  );
  if (!row) return json({ ok: false, error: 'not_found' }, 404);

  if (env.V50_INDEX) {
    try {
      await measure(timing, 'vector_delete_ms', () => env.V50_INDEX.deleteByIds([id]));
    } catch (error) {
      console.error('Vectorize deleteByIds failed (continuing)', error);
    }
  }

  await measure(timing, 'db_delete_ms', () =>
    env.DB.prepare('DELETE FROM corpus_items WHERE id = ?').bind(id).run()
  );

  timing.total_ms = elapsedMs(startedAt);
  return timedJson({ ok: true, id, status: 'deleted' }, timing);
}

async function embedText(env, text) {
  const response = await env.AI.run(CONFIG.ai.embeddingModel, { text: [text] });
  const vector = extractFirstEmbedding(response);
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Empty embedding');
  }
  return vector;
}

function extractFirstEmbedding(response) {
  const result = response?.result || response;
  const data = result?.data || result?.embeddings || response?.data;
  if (Array.isArray(data) && Array.isArray(data[0])) return data[0];
  if (Array.isArray(data) && Array.isArray(result?.shape) && result.shape.length === 2) {
    const dimensions = result.shape[1];
    return data.slice(0, dimensions);
  }
  if (Array.isArray(data) && data.every((value) => typeof value === 'number')) return data;
  return [];
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw json({ ok: false, error: 'Content-Type must be application/json' }, 415);
  }
  try {
    return await request.json();
  } catch {
    throw json({ ok: false, error: 'Invalid JSON' }, 400);
  }
}

async function measure(timing, key, callback) {
  const start = performance.now();
  try {
    return await callback();
  } finally {
    timing[key] = elapsedMs(start);
  }
}

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...corsHeaders(),
      ...headers
    }
  });
}

function timedJson(body, timing, status = 200, headers = {}) {
  return json(body, status, {
    'Server-Timing': formatServerTiming(timing),
    ...headers
  });
}

function formatServerTiming(timing) {
  return Object.entries(timing)
    .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    .map(([key, value]) => `${key.replace(/_/g, '-')};dur=${value}`)
    .join(', ');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Expose-Headers': 'Server-Timing'
  };
}
```

- [ ] **Step 2: Syntax check**

Run: `node --check functions/api/admin/approve.js`

Expected: exit 0.

- [ ] **Step 3: Add local secret**

Wrangler reads `.dev.vars` (gitignored by default — confirm by running `git check-ignore .dev.vars`; if it returns no path, manually add `.dev.vars` to `.gitignore` before continuing).

Create `.dev.vars` at the repo root with:

```
ADMIN_TOKEN=dev-local-token
```

Restart `npm run dev` so wrangler picks up the new variable.

- [ ] **Step 4: Probe unauthorized**

Use a pending id from earlier tasks (or submit another row first).

```bash
PENDING_ID=$(curl -s -X POST http://localhost:8788/api/corpus/list -H 'Content-Type: application/json' -d '{"status":"pending","page_size":1}' | python3 -c "import sys, json; print(json.load(sys.stdin)['items'][0]['id'])")
echo "PENDING_ID=$PENDING_ID"

curl -i -s -X POST http://localhost:8788/api/admin/approve \
  -H 'Content-Type: application/json' \
  -d "{\"id\":\"$PENDING_ID\",\"action\":\"approve\"}" | head -1
```

Expected: `HTTP/1.1 401 Unauthorized` (or similar status line). Body: `{"ok":false,"error":"unauthorized"}`.

- [ ] **Step 5: Probe approve with the right token**

```bash
curl -s -X POST http://localhost:8788/api/admin/approve \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: dev-local-token' \
  -d "{\"id\":\"$PENDING_ID\",\"action\":\"approve\"}"
```

Expected: `{"ok":true,"id":"v50_...","status":"approved"}`.

- [ ] **Step 6: Verify the approved row landed in Vectorize**

```bash
curl -s -X POST http://localhost:8788/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"keywords":"周四进度条"}'
```

Expected: a generated text plus `reference_ids` array. The approved id MAY appear in `reference_ids` (depends on retrieval ranking); the important assertion is that the request succeeds and the row is in `status='approved'` per:

```bash
npx wrangler d1 execute v50-db --local \
  --command "SELECT id, status, approved_at FROM corpus_items WHERE id = '$PENDING_ID';"
```

Expected: one row with `status='approved'` and a non-null `approved_at`.

- [ ] **Step 7: Probe already-approved**

```bash
curl -i -s -X POST http://localhost:8788/api/admin/approve \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: dev-local-token' \
  -d "{\"id\":\"$PENDING_ID\",\"action\":\"approve\"}" | head -1
```

Expected: `HTTP/1.1 409`. Body: `{"ok":false,"error":"already_approved"}`.

- [ ] **Step 8: Probe delete**

Submit one more row, capture its id, then:

```bash
DELETE_ID=$(curl -s -X POST http://localhost:8788/api/corpus/submit -H 'Content-Type: application/json' -d '{"text":"删除测试：周四这条投稿是用来验证管理员删除流程的二十几个字"}' | python3 -c "import sys, json; print(json.load(sys.stdin)['id'])")

curl -s -X POST http://localhost:8788/api/admin/approve \
  -H 'Content-Type: application/json' \
  -H 'X-Admin-Token: dev-local-token' \
  -d "{\"id\":\"$DELETE_ID\",\"action\":\"delete\"}"
```

Expected: `{"ok":true,"id":"v50_...","status":"deleted"}`. Then `SELECT * FROM corpus_items WHERE id = '$DELETE_ID'` returns zero rows.

- [ ] **Step 9: Commit**

```bash
git add functions/api/admin/approve.js
git commit -m "Add /api/admin/approve endpoint"
```

---

## Task 12: Admin page

**Files:**
- Create: `public/admin.html`
- Create: `public/admin.js`
- Modify: `public/index.html` (footer admin link)
- Modify: `public/styles.css` (admin page styles)

- [ ] **Step 1: Create admin.html**

Create `public/admin.html` with:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>语料审核 · V我50 文案机</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body class="admin-page">
    <header class="topbar" aria-label="站点导航">
      <a class="topbar-brand" href="/" aria-label="返回首页">
        <span class="brand-mark">V</span>
        <span>语料审核</span>
      </a>
      <a class="text-btn subtle admin-back" href="/">返回</a>
    </header>

    <main class="admin-shell">
      <section id="tokenGate" class="token-gate">
        <h2>管理员登录</h2>
        <p class="submit-help">输入 ADMIN_TOKEN secret 后才能审核。</p>
        <form id="tokenForm">
          <input id="tokenInput" type="password" autocomplete="off" required placeholder="ADMIN_TOKEN" />
          <button class="btn primary" type="submit">登录</button>
        </form>
        <p id="tokenError" class="form-error" hidden></p>
      </section>

      <section id="queue" class="queue-card" hidden>
        <header class="queue-head">
          <div>
            <p class="section-kicker">待审核</p>
            <h2>投稿队列</h2>
          </div>
          <div class="queue-head-actions">
            <button id="queueRefresh" class="btn ghost" type="button">刷新</button>
            <button id="tokenClear" class="text-btn subtle" type="button">清除登录</button>
          </div>
        </header>
        <ul id="queueList" class="queue-list" aria-live="polite">
          <li class="empty">加载中...</li>
        </ul>
      </section>
    </main>

    <div id="toastHost" class="toast-host" aria-live="polite"></div>

    <script src="config.js"></script>
    <script src="admin.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Create admin.js**

Create `public/admin.js` with:

```js
const ADMIN_CONFIG = window.V50_CONFIG.admin;
const CORPUS_LABELS = window.V50_CONFIG.corpus.statusLabels;

const tokenGate = document.getElementById('tokenGate');
const tokenForm = document.getElementById('tokenForm');
const tokenInput = document.getElementById('tokenInput');
const tokenError = document.getElementById('tokenError');
const queueSection = document.getElementById('queue');
const queueList = document.getElementById('queueList');
const refreshBtn = document.getElementById('queueRefresh');
const tokenClearBtn = document.getElementById('tokenClear');
const toastHost = document.getElementById('toastHost');

let adminToken = localStorage.getItem(ADMIN_CONFIG.tokenStorageKey) || '';
let loading = false;

function showToast(message, kind) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind || 'info'}`;
  toast.textContent = message;
  toastHost.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, ADMIN_CONFIG.toastTimeoutMs);
}

function showGate() {
  tokenGate.hidden = false;
  queueSection.hidden = true;
}

function showQueue() {
  tokenGate.hidden = true;
  queueSection.hidden = false;
  loadQueue();
}

function setToken(value) {
  adminToken = value;
  if (value) {
    localStorage.setItem(ADMIN_CONFIG.tokenStorageKey, value);
  } else {
    localStorage.removeItem(ADMIN_CONFIG.tokenStorageKey);
  }
}

async function probeToken(token) {
  // Probe by attempting an approve with a guaranteed-missing id.
  // 401 → wrong token. 404 (not_found) or 400 → token is valid.
  try {
    const response = await fetch('/api/admin/approve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': token
      },
      body: JSON.stringify({ id: 'v50_probe_invalid', action: 'approve' })
    });
    return response.status !== 401;
  } catch {
    return false;
  }
}

async function loadQueue() {
  if (loading) return;
  loading = true;
  queueList.innerHTML = '<li class="empty">加载中...</li>';

  try {
    const response = await fetch('/api/corpus/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending', page: 1, page_size: ADMIN_CONFIG.pageSize })
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error('list failed');

    if (!payload.items || payload.items.length === 0) {
      queueList.innerHTML = '<li class="empty">队列空空如也。</li>';
    } else {
      queueList.innerHTML = '';
      payload.items.forEach((item) => queueList.append(renderQueueItem(item)));
    }
  } catch (error) {
    console.error(error);
    queueList.innerHTML = `<li class="empty">${ADMIN_CONFIG.messages.generic}</li>`;
  } finally {
    loading = false;
  }
}

function renderQueueItem(item) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.dataset.id = item.id;

  const text = document.createElement('p');
  text.className = 'queue-text';
  text.textContent = item.text;

  const meta = document.createElement('p');
  meta.className = 'queue-meta';
  const author = document.createElement('span');
  author.textContent = `作者：${item.author || '匿名'}`;
  const time = document.createElement('span');
  const submittedAt = item.submitted_at || item.created_at;
  time.textContent = submittedAt ? `投稿：${submittedAt}` : '';
  meta.append(author, time);

  const actions = document.createElement('div');
  actions.className = 'queue-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn primary';
  approveBtn.type = 'button';
  approveBtn.textContent = '通过';
  approveBtn.addEventListener('click', () => act(item.id, 'approve', approveBtn, li));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn ghost danger';
  deleteBtn.type = 'button';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', () => act(item.id, 'delete', deleteBtn, li));

  actions.append(approveBtn, deleteBtn);
  li.append(text, meta, actions);
  return li;
}

async function act(id, action, sourceBtn, li) {
  if (sourceBtn.disabled) return;
  sourceBtn.disabled = true;
  const original = sourceBtn.textContent;
  sourceBtn.textContent = action === 'approve' ? '处理中...' : '删除中...';

  try {
    const response = await fetch('/api/admin/approve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminToken
      },
      body: JSON.stringify({ id, action })
    });
    let payload = null;
    try { payload = await response.json(); } catch {}

    if (response.status === 401) {
      setToken('');
      showToast(ADMIN_CONFIG.messages.unauthorized, 'error');
      showGate();
      return;
    }
    if (!response.ok || !payload?.ok) {
      const isEmbedError = payload?.error === 'embed_failed' || payload?.error === 'upsert_failed';
      const message = isEmbedError
        ? ADMIN_CONFIG.messages.embedFailed
        : ADMIN_CONFIG.messages.generic;
      showToast(message, 'error');
      sourceBtn.disabled = false;
      sourceBtn.textContent = original;
      return;
    }

    showToast(
      action === 'approve' ? ADMIN_CONFIG.messages.approved : ADMIN_CONFIG.messages.deleted,
      'success'
    );
    li.remove();
    if (queueList.children.length === 0) {
      queueList.innerHTML = '<li class="empty">队列空空如也。</li>';
    }
  } catch (error) {
    console.error(error);
    showToast(ADMIN_CONFIG.messages.generic, 'error');
    sourceBtn.disabled = false;
    sourceBtn.textContent = original;
  }
}

tokenForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim();
  if (!value) return;
  const valid = await probeToken(value);
  if (!valid) {
    tokenError.textContent = ADMIN_CONFIG.messages.unauthorized;
    tokenError.hidden = false;
    return;
  }
  setToken(value);
  tokenError.hidden = true;
  tokenInput.value = '';
  showQueue();
});

refreshBtn.addEventListener('click', loadQueue);
tokenClearBtn.addEventListener('click', () => {
  setToken('');
  tokenInput.value = '';
  showGate();
});

if (adminToken) {
  showQueue();
} else {
  showGate();
}
```

- [ ] **Step 3: Add footer admin link to index.html**

Edit `public/index.html`. Replace the existing `<footer class="site-footer">...</footer>` block (lines 88–92) with:

```html
    <footer class="site-footer">
      <span>(c) 2026 V50 Copywriter.</span>
      <span>Fan-made, not affiliated with KFC.</span>
      <span>本机只负责生成借口，到账靠群友心情。</span>
      <a class="text-btn subtle admin-link" href="/admin">管理</a>
    </footer>
```

- [ ] **Step 4: Add admin CSS**

Edit `public/styles.css`. Append at the very end:

```css
.admin-page {
  background:
    linear-gradient(135deg, rgba(215, 25, 32, 0.05) 25%, transparent 25%) 0 0 / 28px 28px,
    linear-gradient(180deg, #fff7e8 0%, #fff 60%, #fff2e4 100%);
}

.admin-shell {
  width: min(720px, calc(100% - 28px));
  margin: 18px auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.admin-back {
  text-decoration: none;
}

.token-gate,
.queue-card {
  padding: 18px;
  border: 1px solid rgba(117, 58, 29, 0.18);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.94);
  box-shadow: var(--shadow);
}

.token-gate form {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.token-gate input {
  flex: 1;
}

.token-gate .btn.primary {
  min-width: 96px;
}

.form-error {
  margin: 10px 0 0;
  color: var(--red-dark);
  font-weight: 800;
  font-size: 14px;
}

.queue-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.queue-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.queue-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.queue-list .empty {
  padding: 24px;
  text-align: center;
  color: var(--muted);
  border: 1px dashed var(--line);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.6);
}

.queue-item {
  padding: 14px;
  border: 1px solid #e6c870;
  border-radius: 8px;
  background: #fff6df;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.queue-text {
  margin: 0;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.queue-meta {
  margin: 0;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--muted);
}

.queue-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}

.queue-actions .btn {
  min-height: 38px;
  padding: 0 16px;
}

.btn.ghost.danger {
  color: var(--red-dark);
  border-color: rgba(169, 15, 22, 0.32);
}

.admin-link {
  text-decoration: none;
}
```

- [ ] **Step 5: Syntax check**

Run: `node --check public/admin.js`

Expected: exit 0.

- [ ] **Step 6: Smoke test the admin flow end to end**

Open `http://localhost:8788/admin` in a browser (or click the `管理` link in the footer of `/`).

Expected:
- Token gate appears.
- Type a wrong token (e.g. `nope`) → red error "验证失败，请检查 token", form remains.
- Type `dev-local-token` (the value in `.dev.vars`) → gate hides, queue loads with all pending rows.
- Click `通过` on any row → green toast "已通过", row disappears from the list.
- Submit a fresh row via `/`'s 投稿 tab, return to `/admin`, click 刷新, the new row appears, click 删除 → green toast "已删除", row disappears.
- Refresh the browser tab on `/admin` while logged in: queue loads immediately (token persisted to localStorage).
- Click 清除登录 → gate reappears.

- [ ] **Step 7: Verify the approved row is now in `已收录` on the main page**

Navigate to `/`, click 语料, click 已收录, search for the text you just approved. It should appear.

Then call `/api/generate` with a relevant keyword and verify the approved id may appear in `reference_ids`:

```bash
curl -s -X POST http://localhost:8788/api/generate \
  -H 'Content-Type: application/json' \
  -d '{"keywords":"<keyword from your approved text>"}' | python3 -m json.tool
```

Expected: a generated text plus `reference_ids` of length up to 6. The approved id may or may not be present (retrieval is ranked, not exhaustive), but the call succeeds.

- [ ] **Step 8: Commit**

```bash
git add public/admin.html public/admin.js public/index.html public/styles.css
git commit -m "Add admin approval page"
```

---

## Task 13: Extend the `check` script

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update the check script**

Edit `package.json`. Replace the `"check"` script line with:

```json
    "check": "node --check public/config.js && node --check public/app.js && node --check public/corpus.js && node --check public/submit.js && node --check public/admin.js && node --check functions/_lib/config.js && node --check functions/_lib/corpus-id.js && node --check functions/api/generate.js && node --check functions/api/copy.js && node --check functions/api/corpus/list.js && node --check functions/api/corpus/submit.js && node --check functions/api/admin/approve.js && node --check scripts/corpus-id.mjs && node --check scripts/import-corpus.mjs && node --check scripts/index-corpus.mjs",
```

- [ ] **Step 2: Run it**

Run: `npm run check`

Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "Cover new JS files with npm run check"
```

---

## Task 14: Update README files

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Update English README**

Edit `README.md`. Find the `## Contribute to the Corpus` section (currently the last section, beginning with "The example corpus lives in...") and replace from that heading through the end of the file with:

```markdown
## Contribute to the Corpus

The easiest way to contribute is through the website. On the home page, open the **投稿** tab, paste a 20–180 character V50 line, optionally add an author/source, and submit. The maintainer reviews submissions and approves the ones that fit; approved lines start appearing in generations within minutes.

You can browse what's already in the corpus (including pending submissions) from the **语料** tab on the same page.

### Bulk PR Flow (advanced)

For batch contributions or one-off bootstrapping, the original PR-based flow still works. The seed corpus lives in [`references/v50_corpus.json`](references/v50_corpus.json). Each entry looks like this:

```json
{
  "text": "your V50 copy goes here",
  "author": "your name or where it came from",
  "source_url": "https://link-to-the-original/or_empty"
}
```

Add your items to the `items` array, open a PR, and the maintainer will run `npm run import:corpus` + `npm run index:corpus` after merge to materialize them.
```

(Note: the inner `json` fence is intentional — it's an embedded code block inside the section.)

- [ ] **Step 2: Update Chinese README**

Edit `README.zh-CN.md`. Find the `## 贡献语料` section (currently the last section) and replace from that heading through the end of the file with:

```markdown
## 贡献语料

最简单的方式是通过网站投稿。打开首页的 **投稿** 标签页，写下一条 20–180 字的 V50 文案，可选填写作者 / 出处，提交即可。维护者会审核合适的投稿；通过后几分钟内就有机会出现在生成结果里。

也可以在同一页的 **语料** 标签页浏览已经收录的文案，以及还在排队的投稿。

### 批量 PR 流程（进阶）

如果想一次性贡献一大批文案，原来的 PR 流程仍然可用。种子语料放在 [`references/v50_corpus.json`](references/v50_corpus.json)，每一条长这样：

```json
{
  "text": "在这里写你的 V50 文案",
  "author": "你的名字或出处",
  "source_url": "https://原文链接/可为空"
}
```

把条目加进 `items` 数组提一个 PR，合并后维护者会跑 `npm run import:corpus` 和 `npm run index:corpus` 把它们写入数据库。
```

- [ ] **Step 3: Commit**

```bash
git add README.md README.zh-CN.md
git commit -m "Point contributors to the website; demote PR flow"
```

---

## Final verification

After all 14 tasks are committed, run the full repro of the spec's manual verification checklist:

- [ ] **Step 1: Clean syntax pass**

```bash
npm run check
```

Expected: exit 0.

- [ ] **Step 2: Restart dev server fresh and verify migration is idempotent**

Stop and restart `npm run dev`. Look for no migration errors in the startup output.

- [ ] **Step 3: End-to-end happy path**

In a browser at `http://localhost:8788/`:
1. Open 语料 tab, confirm seed rows appear under 已收录.
2. Open 投稿 tab, submit a 30-char V50 line, see green success toast.
3. Open 语料 tab → 待审核 → confirm the row appears.
4. Open `/admin`, log in with `dev-local-token`, click 通过 on the new row, see green toast "已通过".
5. Open 语料 tab → 已收录 → confirm the row appears.
6. Open 生成 tab, generate with a keyword from the approved row, verify the response is normal.

- [ ] **Step 4: Sad paths**

1. Submit the same text again → red toast "这条已在投稿队列中" (or "已经在语料库里了" if approved).
2. Submit `"短"` → red toast "至少 20 个字".
3. Submit 5 fresh lines, then try a 6th → first 5 succeed, 6th hits 429 (only visible from non-localhost; on localhost this is bypassed — note in the test summary that this gate is exercised by code review of `submit.js`'s `isLocalDevRequest` bypass).
4. On `/admin`, log out (清除登录), enter `wrong` → red inline error "验证失败，请检查 token".

- [ ] **Step 5: Deploy preview verification (post-merge)**

After deploy to a Cloudflare Pages preview, set the production secret:

```bash
npx wrangler secret put ADMIN_TOKEN
```

(enter a strong random value).

Then run the migration on remote:

```bash
npm run migrate:remote
```

Open the preview URL, repeat steps 3 and 4 above against the preview. Confirm the rate-limit gate fires when intentionally exceeded (this only works on a non-localhost origin).

Plan complete.
