import { CONFIG } from '../_lib/config.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders()
    });
  }

  if (context.request.method !== 'POST') {
    return json({ ok: false, error: 'Method Not Allowed' }, 405, {
      Allow: 'POST, OPTIONS'
    });
  }

  return handleCopy(context);
}

async function handleCopy(context) {
  const { request, env } = context;

  try {
    if (!env.DB) {
      return json({ ok: false, error: 'Copy logger is not configured' }, 503);
    }

    if (!isLocalDevRequest(request) && (await isMinuteRateLimited(env.RATE_LIMIT, 'copy', getClientIp(request)))) {
      return json({ ok: false, error: 'rate_limited' }, 429);
    }

    const payload = await readJson(request);
    const input = normalizeInput(payload);

    const result = await env.DB.prepare(
      `INSERT OR IGNORE INTO copied_outputs
        (id, keywords, copied_text, attempt_no, reference_ids, previous_outputs)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        input.id,
        input.keywords,
        input.copied_text,
        input.attempt_no,
        JSON.stringify(input.reference_ids),
        JSON.stringify(input.previous_outputs)
      )
      .run();

    const inserted = (result?.meta?.changes ?? 0) > 0;
    if (inserted) {
      queueBackgroundTask(context, recordAcceptedReferenceUsage(env.DB, input.reference_ids), 'Accepted reference usage update failed');
    }

    return json({ ok: true, id: input.id, duplicate: !inserted });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return json({ ok: false, error: 'Copy log failed' }, 500);
  }
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

function normalizeInput(payload) {
  const { input: inputCfg } = CONFIG;
  const id = typeof payload?.id === 'string' ? payload.id.trim().toLowerCase() : '';
  const keywords = typeof payload?.keywords === 'string' ? payload.keywords.trim().slice(0, inputCfg.keywordLimit) : '';
  const copiedText = typeof payload?.copied_text === 'string' ? payload.copied_text.trim() : '';
  const attemptNo = Number.isInteger(payload?.attempt_no) ? payload.attempt_no : 0;

  if (!UUID_PATTERN.test(id)) {
    throw json({ ok: false, error: 'id must be a UUID' }, 400);
  }
  if (!copiedText) {
    throw json({ ok: false, error: 'copied_text is required' }, 400);
  }

  return {
    id,
    keywords,
    copied_text: copiedText.slice(0, inputCfg.copyTextLimit),
    attempt_no: Math.max(attemptNo, 0),
    reference_ids: normalizeStringArray(payload?.reference_ids, inputCfg.usedReferenceIdsLimit, inputCfg.usedReferenceIdItemLimit),
    previous_outputs: normalizeStringArray(payload?.previous_outputs, inputCfg.previousOutputsLimit, inputCfg.previousOutputItemLimit)
  };
}

function normalizeStringArray(value, limit, itemLimit) {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().slice(0, itemLimit))
    .filter(Boolean)
    .slice(0, limit);
}

async function recordAcceptedReferenceUsage(db, ids) {
  if (!db) return;

  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.length === 0) return;

  await db.batch(
    uniqueIds.map((id) =>
      db
        .prepare(
          `UPDATE corpus_items
             SET accepted_reference_count = COALESCE(accepted_reference_count, 0) + 1,
                 last_accepted_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(id)
    )
  );
}

function queueBackgroundTask(context, task, errorMessage) {
  const guardedTask = Promise.resolve(task).catch((error) => {
    console.error(errorMessage, error);
  });

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(guardedTask);
  }
}

// Per-IP minute-bucket limit (10/min, shared CONFIG.rateLimit knobs). Same
// non-atomic GET→+1→PUT pattern as generate.js; `scope` keeps keys distinct.
async function isMinuteRateLimited(kv, scope, ip) {
  if (!kv) return false;
  const { minutely, minuteBucketTtlSeconds } = CONFIG.rateLimit;
  const minuteBucket = Math.floor(Date.now() / 60000);
  const key = `rl:${scope}:${ip}:m:${minuteBucket}`;
  const current = Number((await kv.get(key)) || '0');
  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl: minuteBucketTtlSeconds });
  return next > minutely;
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function isLocalDevRequest(request) {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
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
    // Same-origin app uses relative fetch paths; lock cross-origin reads to our domain.
    'Access-Control-Allow-Origin': 'https://v50.reporkey.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
