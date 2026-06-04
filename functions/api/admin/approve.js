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
      return await doApprove(context, id, timing, startedAt);
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

async function doApprove(context, id, timing, startedAt) {
  const { env } = context;

  const row = await measure(timing, 'lookup_ms', () =>
    env.DB.prepare('SELECT id, text, author, status FROM corpus_items WHERE id = ?').bind(id).first()
  );
  if (!row) {
    timing.total_ms = elapsedMs(startedAt);
    return timedJson({ ok: false, error: 'not_found' }, timing, 404);
  }
  if (row.status === 'approved') {
    timing.total_ms = elapsedMs(startedAt);
    return timedJson({ ok: false, error: 'already_approved' }, timing, 409);
  }

  // Mark 'indexing' first so a request that dies mid-flight leaves the row
  // visible in the admin queue (with a working 重试索引) instead of half-done.
  // 'indexing' is accepted by the status filter below, which is that retry path.
  await measure(timing, 'db_update_ms', () =>
    env.DB
      .prepare(
        `UPDATE corpus_items
            SET status = 'indexing',
                approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP)
          WHERE id = ?
            AND status IN ('pending', 'indexing')`
      )
      .bind(id)
      .run()
  );

  // Embed + upsert + promote run synchronously (~1-2s) so the response reflects
  // the real outcome. The old waitUntil version could get cut off after the
  // Vectorize upsert but before the final D1 promote — reporting ok:true while
  // the row stayed 'indexing' forever (bit us in prod on 2026-05-29).
  try {
    await indexCorpusItem(env, row, timing);
  } catch (error) {
    const code = error?.step || 'embed_failed';
    console.error(`Indexing failed for ${row.id} (${code})`, error);
    timing.total_ms = elapsedMs(startedAt);
    // Row stays 'indexing': still in the queue and retryable, and the admin
    // sees a real error instead of a fake success.
    return timedJson({ ok: false, error: code }, timing, code === 'binding_missing' ? 503 : 502);
  }

  timing.total_ms = elapsedMs(startedAt);
  return timedJson({ ok: true, id, status: 'approved' }, timing);
}

// Embed text via Workers AI, upsert into Vectorize, then promote the D1 row to
// 'approved' with indexed_at stamped. Each step tags failures with `step` so
// the caller can report which stage broke; on any throw the row stays 'indexing'.
async function indexCorpusItem(env, row, timing) {
  if (!env.AI || !env.V50_INDEX || !env.DB) {
    throw withStep('binding_missing', new Error('AI/Vectorize/DB binding missing — cannot index'));
  }
  const vector = await measure(timing, 'embed_ms', () => embedText(env, row.text)).catch((error) => {
    throw withStep('embed_failed', error);
  });
  await measure(timing, 'upsert_ms', () =>
    env.V50_INDEX.upsert([
      {
        id: row.id,
        values: vector,
        metadata: row.author ? { author: row.author } : {}
      }
    ])
  ).catch((error) => {
    throw withStep('upsert_failed', error);
  });
  // Only now is the vector accepted, so promote 'indexing' → 'approved' and
  // stamp indexed_at. Until this runs the row stays 'indexing' and out of RAG.
  await measure(timing, 'promote_ms', () =>
    env.DB
      .prepare(
        `UPDATE corpus_items
            SET status = 'approved',
                indexed_at = CURRENT_TIMESTAMP
          WHERE id = ?`
      )
      .bind(row.id)
      .run()
  ).catch((error) => {
    throw withStep('promote_failed', error);
  });
}

function withStep(step, error) {
  const tagged = error instanceof Error ? error : new Error(String(error));
  tagged.step = step;
  return tagged;
}

async function doDelete(env, id, timing, startedAt) {
  const row = await measure(timing, 'lookup_ms', () =>
    env.DB.prepare('SELECT id, status FROM corpus_items WHERE id = ?').bind(id).first()
  );
  if (!row) {
    timing.total_ms = elapsedMs(startedAt);
    return timedJson({ ok: false, error: 'not_found' }, timing, 404);
  }

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
    // Same-origin app uses relative fetch paths; lock cross-origin reads to our domain.
    'Access-Control-Allow-Origin': 'https://v50.reporkey.com',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
    'Access-Control-Expose-Headers': 'Server-Timing'
  };
}
