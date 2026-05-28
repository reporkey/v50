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
      filters.push("text LIKE ? ESCAPE '\\'");
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
