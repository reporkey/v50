// GET|HEAD /healthz — uptime-monitor health check. An external dead-man's-switch probe
// (User-Agent: healthcheck-probe/1.0) hits this every 5 min and treats anything other than
// 200 as DOWN. We probe the two hard dependencies the generator cannot work without — D1 and
// Vectorize — and return 503 if either is genuinely broken, so the monitor also catches an
// "edge is up but the app is dead" outage. No auth, no redirects, not cached.
//
// Fail policy (deliberately fail-safe so transient blips don't page us):
//   • dependency throws, or its binding is missing → unhealthy (503) — a real, sustained fault
//   • dependency doesn't answer within PROBE_TIMEOUT_MS → treated as healthy (200, flagged in
//     X-Health) — a slow probe is usually a momentary latency spike, not an outage
//   • dependency answers → healthy (200)
//
// Both probes are READ-ONLY: D1 runs `SELECT 1` (touches no table, reads no rows) and
// Vectorize runs `query` (similarity search, never upsert/delete). Neither mutates data.
// `context` holds { request, env, waitUntil, params, next }.

const PROBE_TIMEOUT_MS = 800; // keep the whole check comfortably under the monitor's 1s budget

// A fixed, non-zero 1024-dim vector (the index is 1024-dim cosine). The values are irrelevant
// and the returned matches are ignored — we only need a syntactically valid query so Vectorize
// exercises its read path. A constant vector avoids calling Workers AI (BGE-M3) just to embed a
// throwaway query, which would needlessly drag the AI dependency into the health check.
const PROBE_VECTOR = new Array(1024).fill(0.1);

export async function onRequest(context) {
  const { request, env } = context;
  const { method } = request;

  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('method not allowed', {
      status: 405,
      headers: { 'Cache-Control': 'no-store', Allow: 'GET, HEAD' }
    });
  }

  const checks = await Promise.all([checkD1(env), checkVectorize(env)]);
  const healthy = checks.every((c) => c.ok);
  const summary = checks.map((c) => `${c.name}=${c.detail}`).join(';');

  // For HEAD the runtime drops the body; GET gets a tiny status word.
  return new Response(method === 'HEAD' ? null : healthy ? 'ok' : 'unhealthy', {
    status: healthy ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Health': summary // e.g. "d1=ok;vectorize=ok" — for humans debugging, ignored by the monitor
    }
  });
}

// Read-only liveness probe for D1. `SELECT 1` returns a constant and touches no table.
function checkD1(env) {
  if (!env.DB) return Promise.resolve({ name: 'd1', ok: false, detail: 'unbound' });
  return probe('d1', env.DB.prepare('SELECT 1').first());
}

// Read-only liveness probe for Vectorize, using the constant vector above (no embed call).
function checkVectorize(env) {
  if (!env.V50_INDEX) return Promise.resolve({ name: 'vectorize', ok: false, detail: 'unbound' });
  return probe('vectorize', env.V50_INDEX.query(PROBE_VECTOR, { topK: 1 }));
}

// Race a dependency's promise against a timeout and return a {name, ok, detail} verdict.
// Never throws: `work` is pre-wrapped so a late rejection (after the timeout already won) is
// swallowed rather than surfacing as an unhandled rejection. error → unhealthy; timeout →
// healthy-but-flagged (transient blip); success → healthy.
function probe(name, work) {
  const guarded = Promise.resolve(work).then(
    () => ({ name, ok: true, detail: 'ok' }),
    () => ({ name, ok: false, detail: 'error' })
  );
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ name, ok: true, detail: 'timeout' }), PROBE_TIMEOUT_MS);
  });
  return Promise.race([guarded, timeout]).finally(() => clearTimeout(timer));
}
