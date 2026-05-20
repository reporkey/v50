const KEYWORD_LIMIT = 40;
const COPY_TEXT_LIMIT = 500;

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

    const payload = await readJson(request);
    const input = normalizeInput(payload);
    const id = crypto.randomUUID();

    await env.DB.prepare(
      `INSERT INTO copied_outputs
        (id, keywords, copied_text, attempt_no, reference_ids, previous_outputs)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        input.keywords,
        input.copied_text,
        input.attempt_no,
        JSON.stringify(input.reference_ids),
        JSON.stringify(input.previous_outputs)
      )
      .run();

    queueBackgroundTask(context, recordAcceptedReferenceUsage(env.DB, input.reference_ids), 'Accepted reference usage update failed');

    return json({ ok: true, id });
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
  const keywords = typeof payload?.keywords === 'string' ? payload.keywords.trim().slice(0, KEYWORD_LIMIT) : '';
  const copiedText = typeof payload?.copied_text === 'string' ? payload.copied_text.trim() : '';
  const attemptNo = Number.isInteger(payload?.attempt_no) ? payload.attempt_no : 0;

  if (!copiedText) {
    throw json({ ok: false, error: 'copied_text is required' }, 400);
  }

  return {
    keywords,
    copied_text: copiedText.slice(0, COPY_TEXT_LIMIT),
    attempt_no: Math.min(Math.max(attemptNo, 0), 20),
    reference_ids: normalizeStringArray(payload?.reference_ids, 80, 120),
    previous_outputs: normalizeStringArray(payload?.previous_outputs, 5, 360)
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
