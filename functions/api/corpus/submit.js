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

    const payload = await readJson(request);
    const input = normalizeInput(payload);
    const id = await resolveCorpusId({ text: input.text });

    const ip = getClientIp(request);
    const limited =
      !isLocalDevRequest(request) && (await isSubmitRateLimited(env.RATE_LIMIT, ip));
    if (limited) {
      return json({ ok: false, error: '今日投稿次数已达上限' }, 429);
    }

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
