// POST /api/generate — RAG pipeline: embed query → vector search → MMR re-rank → LLM → guardrails.
import { CONFIG } from '../_lib/config.js';

// Pages Functions entry point. Cloudflare invokes this for every request to /api/generate.
// We handle the CORS preflight (OPTIONS) inline and forward POST to the real handler; anything
// else is rejected with 405. `context` holds { request, env, waitUntil, params, next }.
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

  return handleGenerate(context);
}

// Orchestrates the request lifecycle. `timing` is mutated by each phase and emitted as the Server-Timing header.
async function handleGenerate(context) {
  const { request, env } = context;
  const startedAt = performance.now();
  const timing = {
    llm_retried: false
  };

  try {
    // 1. Parse + validate request.
    const payload = await measure(timing, 'read_json_ms', () => readJson(request));
    const input = measureSync(timing, 'normalize_ms', () => normalizeInput(payload));
    const ip = getClientIp(request);

    // 2. Per-IP rate limit (KV), bypassed on localhost so dev isn't throttled.
    const limited =
      !isLocalDevRequest(request) && (await measure(timing, 'rate_limit_ms', () => isRateLimited(env.RATE_LIMIT, ip)));
    if (limited) {
      timing.total_ms = elapsedMs(startedAt);
      const errorMsg = limited.scope === 'day'
        ? `今日请求次数已达上限（每日 ${limited.limit} 次），请明天再试`
        : `请求太频繁（每分钟限 ${limited.limit} 次），请稍后再试`;
      return timedJson({ ok: false, error: errorMsg, timing }, timing, 429);
    }

    if (!env.AI || !env.DB || !env.V50_INDEX) {
      timing.total_ms = elapsedMs(startedAt);
      return timedJson({ ok: false, error: '生成服务未配置', timing }, timing, 503);
    }

    // 3. Embed the query (defaults to a seasonal query if the user gave no keywords).
    const queryText = input.keywords || CONFIG.ai.defaultQuery;
    const queryVector = await measure(timing, 'embedding_query', () => embedText(env, queryText));

    // 4. Retrieve reference snippets via Vectorize + MMR + D1. Soft-fallback to no-RAG if empty.
    const references = await getReferences(env, input, queryVector, timing);
    if (references.length === 0) {
      timing.reference_strategy = 'no_rag';
      console.error('No-RAG fallback engaged', { keywords: input.keywords, attempt_no: input.attempt_no });
    }

    // 5. Build the prompt and call the chat model (one corrective retry if the first output trips guardrails).
    const chatModel = getChatModel(env);
    timing.chat_model = chatModel;
    const prompt = measureSync(timing, 'prompt_ms', () => buildPrompt({
      keywords: input.keywords,
      references,
      previousOutputs: input.previous_outputs
    }));
    const text = await generateText(env, chatModel, prompt, input.attempt_no, timing);
    if (!text) {
      timing.total_ms = elapsedMs(startedAt);
      return timedJson({ ok: false, error: '生成失败，请稍后再试', timing }, timing, 502);
    }

    // 6. Bump reference_count for cited items (background, doesn't delay the response); reply.
    const referenceIds = references.map((item) => item.id);
    queueBackgroundTask(context, recordReferenceUsage(env.DB, referenceIds), 'Reference usage update failed');
    timing.total_ms = elapsedMs(startedAt);
    return timedJson({
      ok: true,
      text,
      attempt_no: input.attempt_no,
      reference_ids: referenceIds,
      source: references.length > 0 ? 'rag' : 'no_rag',
      timing
    }, timing);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    timing.total_ms = elapsedMs(startedAt);
    if (isQuotaError(error)) {
      timing.llm_error = timing.llm_error || 'quota_exhausted';
      return timedJson({ ok: false, error: '今日生成量已用尽，请明天再试', timing }, timing, 429);
    }
    return timedJson({ ok: false, error: '生成失败，请稍后再试', timing }, timing, 500);
  }
}

// Returns up to `referenceLimit` corpus rows for the LLM to draw from. Strategy depends on attempt_no.
async function getReferences(env, input, queryVector, timing) {
  const { referenceLimit, topK: topKConfig, attemptThresholds } = CONFIG.retrieval;

  // Reuse mode (1st-2nd retry): cheapest path — refetch the same references the previous attempt used.
  if (
    input.attempt_no > 0 &&
    input.attempt_no <= attemptThresholds.reuseMax &&
    input.used_reference_ids.length > 0
  ) {
    const rows = await measure(timing, 'reuse_d1_ms', () =>
      fetchCorpusRows(env.DB, input.used_reference_ids.slice(0, referenceLimit))
    );
    if (rows.length > 0) {
      timing.reference_strategy = 'reuse';
      timing.reference_count = rows.length;
      return rows;
    }
  }

  // Search mode: vector lookup + MMR. From attempt 3 onward, broaden topK and exclude used IDs to force novelty.
  const isDeepSearch = input.attempt_no >= attemptThresholds.deepSearch;
  const topK = isDeepSearch ? topKConfig.deepSearch : topKConfig.standard;
  const lambda = getMmrLambda(input.attempt_no);
  const excludedIds = isDeepSearch ? new Set(input.used_reference_ids) : new Set();
  timing.reference_strategy = 'search';
  timing.vector_top_k = topK;
  timing.mmr_lambda = lambda;
  timing.excluded_reference_count = excludedIds.size;

  const candidates = await measure(timing, 'vector_ms', () => queryVectorIndex(env.V50_INDEX, queryVector, topK, excludedIds));
  timing.vector_candidate_count = candidates.length;
  const selected = measureSync(timing, 'mmr_ms', () => selectMmr(candidates, queryVector, referenceLimit, lambda));
  let rows = await measure(timing, 'd1_ms', () =>
    fetchCorpusRows(
      env.DB,
      selected.map((item) => item.id)
    )
  );

  // Fallback: exclusion left too few rows. Re-search without exclusion so the response is never empty.
  if (rows.length < referenceLimit && excludedIds.size > 0) {
    timing.reference_strategy = 'fallback_search';
    const fallbackCandidates = await measure(timing, 'fallback_vector_ms', () =>
      queryVectorIndex(env.V50_INDEX, queryVector, topK, new Set())
    );
    timing.fallback_vector_candidate_count = fallbackCandidates.length;
    const fallbackSelected = measureSync(timing, 'fallback_mmr_ms', () =>
      selectMmr(fallbackCandidates, queryVector, referenceLimit, lambda)
    );
    rows = await measure(timing, 'fallback_d1_ms', () =>
      fetchCorpusRows(
        env.DB,
        fallbackSelected.map((item) => item.id)
      )
    );
  }

  timing.reference_count = rows.length;
  return rows;
}

// Run the embedding model on a single string. Returns the float vector that Vectorize will
// search against. Throws if the response shape is unexpected so the outer catch can 502.
async function embedText(env, text) {
  const response = await env.AI.run(CONFIG.ai.embeddingModel, {
    text: [text]
  });
  const embeddings = extractEmbeddings(response, 1);
  const vector = embeddings[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Embedding failed');
  }
  return vector;
}

// Ask Vectorize for the topK nearest neighbors of `vector`. We need `returnValues: true`
// because MMR has to compute candidate-vs-already-picked similarity, not just rely on the
// query-vs-candidate score Vectorize already returned.
async function queryVectorIndex(index, vector, topK, excludedIds) {
  const result = await index.query(vector, {
    topK,
    returnValues: true,
    returnMetadata: 'all'
  });
  const matches = Array.isArray(result?.matches) ? result.matches : [];

  return matches
    .filter((match) => match?.id && !excludedIds.has(match.id))
    .map((match) => ({
      id: match.id,
      score: typeof match.score === 'number' ? match.score : 0,
      values: Array.isArray(match.values) ? match.values : []
    }));
}

// MMR re-rank: greedy pick maximizing (lambda × relevance to query) − ((1−lambda) × similarity to already-picked).
function selectMmr(candidates, queryVector, limit, lambda) {
  const pool = candidates.filter((item) => item.id);
  const selected = [];

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      // Relevance to the query; fall back to local cosine if Vectorize didn't return a score.
      const relevance = candidate.score || cosineSimilarity(queryVector, candidate.values);
      // Diversity penalty: how similar this candidate is to anything we've already picked.
      const diversityPenalty =
        selected.length === 0
          ? 0
          : Math.max(...selected.map((selectedItem) => cosineSimilarity(candidate.values, selectedItem.values)));
      const score = lambda * relevance - (1 - lambda) * diversityPenalty;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    selected.push(pool.splice(bestIndex, 1)[0]);
  }

  return selected;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Resolve a list of corpus IDs into actual rows from D1. Preserves the input order
// (which is the order MMR chose) so the prompt sees references in their ranked sequence.
// Dedupes IDs and caps at referenceLimit before querying.
async function fetchCorpusRows(db, ids) {
  const uniqueIds = [...new Set(ids)].filter(Boolean).slice(0, CONFIG.retrieval.referenceLimit);
  if (uniqueIds.length === 0) return [];

  const placeholders = uniqueIds.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT id, text, source, source_url FROM corpus_items WHERE id IN (${placeholders})`)
    .bind(...uniqueIds)
    .all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  const byId = new Map(rows.map((row) => [row.id, row]));

  return uniqueIds.map((id) => byId.get(id)).filter(Boolean);
}

// Bump reference_count and last_referenced_at for each corpus item we cited.
// Runs in the background via waitUntil so the user's response isn't delayed.
// Distinct from copy.js's recordAcceptedReferenceUsage, which tracks the *accepted* signal.
async function recordReferenceUsage(db, ids) {
  if (!db) return;

  const uniqueIds = [...new Set(ids)].filter(Boolean).slice(0, CONFIG.retrieval.referenceLimit);
  if (uniqueIds.length === 0) return;

  await db.batch(
    uniqueIds.map((id) =>
      db
        .prepare(
          `UPDATE corpus_items
             SET reference_count = COALESCE(reference_count, 0) + 1,
                 last_referenced_at = CURRENT_TIMESTAMP
           WHERE id = ?`
        )
        .bind(id)
    )
  );
}

// Calls the chat model with the prompt; retries once with a corrective addendum if the first output trips guardrails.
// Returns '' if both attempts fail (caller turns that into a 502).
async function generateText(env, chatModel, prompt, attemptNo, timing) {
  // 1st prompt = the real one; 2nd is only used if the 1st result flips the payment direction or empties out.
  const prompts = [
    prompt,
    `${prompt}\n质量修正：上一版可能把付款方向写反了。请重写一条，必须是“我向读者/群友要 50”，不能写“我请你/我请大家/我请客”。`
  ];

  for (let i = 0; i < prompts.length; i += 1) {
    const currentPrompt = prompts[i];
    const llmStart = performance.now();
    const requestBody = {
      messages: [
        {
          role: 'system',
          content: getSystemPrompt(chatModel)
        },
        {
          role: 'user',
          content: currentPrompt
        }
      ],
      max_completion_tokens: CONFIG.ai.maxCompletionTokens,
      temperature: getTemperature(attemptNo)
    };
    const chatTemplateKwargs = getChatTemplateKwargs(chatModel);
    if (Object.keys(chatTemplateKwargs).length > 0) {
      requestBody.chat_template_kwargs = chatTemplateKwargs;
    }

    const aiRunOptions = getAiRunOptions(chatModel);
    let aiResponse;
    try {
      aiResponse =
        Object.keys(aiRunOptions).length > 0
          ? await env.AI.run(chatModel, requestBody, aiRunOptions)
          : await env.AI.run(chatModel, requestBody);
    } catch (error) {
      if (isQuotaError(error)) {
        timing.llm_error = 'quota_exhausted';
        console.error('Workers AI quota hit', error);
      } else {
        console.error('LLM generation failed', error);
        timing.llm_error = error instanceof Error ? error.name : 'AIError';
      }
      throw error;
    }
    const llmMs = elapsedMs(llmStart);
    timing[`llm_attempt_${i + 1}_ms`] = llmMs;
    timing.llm_ms = Math.round(((timing.llm_ms || 0) + llmMs) * 10) / 10;
    timing.llm_attempts = i + 1;
    // Accept the first usable + guardrail-passing output; otherwise record the retry and loop.
    const text = extractText(aiResponse);
    if (text && !violatesCopyRules(text)) {
      return text;
    }
    timing.llm_retried = true;
  }

  return '';
}

// Composes the user prompt. The Chinese section labels in the returned array (关键词, 参考 V50 文案,
// 上一版文案, 要求) are what the model anchors to; system role lives in getSystemPrompt.
function buildPrompt({ keywords, references, previousOutputs }) {
  const topic = keywords || CONFIG.ai.defaultQuery;
  const referenceLines = references.map((item, index) => `${index + 1}. ${item.text.trim()}`);
  const previousLines =
    previousOutputs.length === 0
      ? ['无']
      : previousOutputs.map((item, index) => `${index + 1}. ${item.trim()}`).filter((item) => item.length > 3);
  // Drop the "参考 V50 文案：" header entirely when there are no refs, so the prompt doesn't carry a phantom empty section.
  const referenceBlock = referenceLines.length > 0
    ? ['参考 V50 文案：', ...referenceLines, '']
    : [];

  return [
    '你是中文互联网 疯狂星期四 V我50 梗写手。',
    '疯狂星期四是一个网络 memo, 以肯德基每周四的优惠活动为主题, 结合各种有趣、疯狂、搞笑的故事、情节或事件, 通过在结尾处做出意外的转折来迷惑和激发读者的兴趣和情绪, 并提出v我50。',
    'V我50 的意思是：我向读者/群友要 50 元。',
    '',
    '关键词：',
    topic,
    '',
    ...referenceBlock,
    '上一版文案：',
    ...previousLines,
    '',
    '要求：',
    '- 只输出一条正文',
    '- 20-180 个中文字符左右',
    '- 回答应具有搞笑、意外或突兀的效果',
    '- 关键词必须自然成为铺垫的一部分',
    '- v我50只在最后才会出现. 前面故事阶段不要出现. ​',
    '- 可以借鉴参考文案的节奏、反转方式和互联网语感',
    '- 不要照抄参考文案',
    '- 不要重复上一版的开头、结构或结尾',
    '- 最后要让读者明白“我在向你/群友要 50”'
  ].join('\n');
}

// Lambda + temperature ladder driven by attempt_no (each "再来一条" click bumps it by 1):
//   0 → 0.75 / 0.9       1–2 → 0.75 / 0.95      3 → 0.55 / 1.0       4+ → 0.45 / 1.0
// Together they push the pipeline toward more variety on each retry.
function getMmrLambda(attemptNo) {
  const { mmrLambda, attemptThresholds } = CONFIG.retrieval;
  if (attemptNo >= attemptThresholds.maxDiversity) return mmrLambda.diverse;
  if (attemptNo >= attemptThresholds.deepSearch) return mmrLambda.balanced;
  return mmrLambda.focused;
}

function getTemperature(attemptNo) {
  const { temperature } = CONFIG.ai;
  if (attemptNo >= CONFIG.retrieval.attemptThresholds.deepSearch) return temperature.deepSearch;
  if (attemptNo >= 1) return temperature.regen;
  return temperature.initial;
}

// Normalize Workers AI embedding responses (shape varies by model) into [[...], [...]]. Returns [] if no shape matches.
function extractEmbeddings(response, expectedCount) {
  const result = response?.result || response;
  const data = result?.data || result?.embeddings || response?.data;

  // Shape 1: already an array of vectors.
  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data;
  }

  // Shape 2: flat float array + a [rows, dim] shape — chunk it into rows.
  if (Array.isArray(data) && Array.isArray(result?.shape) && result.shape.length === 2) {
    const [rows, dimensions] = result.shape;
    const embeddings = [];
    for (let row = 0; row < rows; row += 1) {
      embeddings.push(data.slice(row * dimensions, (row + 1) * dimensions));
    }
    return embeddings;
  }

  // Shape 3: single flat vector. Only trusted when the caller is asking for exactly one.
  if (Array.isArray(data) && expectedCount === 1 && data.every((value) => typeof value === 'number')) {
    return [data];
  }

  return [];
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

// Validate + clamp the request body. Only oversize `keywords` throws 400; everything else silently bounds.
function normalizeInput(payload) {
  const { input: inputCfg } = CONFIG;
  const keywords = typeof payload?.keywords === 'string' ? payload.keywords.trim() : '';
  const attemptNo = Number.isInteger(payload?.attempt_no) ? payload.attempt_no : 0;

  if (keywords.length > inputCfg.keywordLimit) {
    throw json({ ok: false, error: `关键词太长，请控制在 ${inputCfg.keywordLimit} 字以内` }, 400);
  }

  return {
    keywords,
    // Clamp attempt_no so a hostile client can't push the ladders to absurd values.
    attempt_no: Math.min(Math.max(attemptNo, 0), inputCfg.maxAttemptNo),
    previous_outputs: normalizeStringArray(payload?.previous_outputs, inputCfg.previousOutputsLimit, inputCfg.previousOutputItemLimit),
    used_reference_ids: normalizeStringArray(payload?.used_reference_ids, inputCfg.usedReferenceIdsLimit, inputCfg.usedReferenceIdItemLimit)
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

// Allow overriding the chat model via the env.CHAT_MODEL variable (set in wrangler.toml or
// the dashboard) so we can A/B a different model in production without a redeploy.
function getChatModel(env) {
  const model = typeof env.CHAT_MODEL === 'string' ? env.CHAT_MODEL.trim() : '';
  return model || CONFIG.ai.chatModel;
}

// Model-specific system prompt tweaks. Qwen needs an explicit "/no_think" suffix to skip
// its visible reasoning trace; other models just get the base prompt.
function getSystemPrompt(chatModel) {
  const base =
    '你是一个中文互联网 V50 梗写手，擅长疯狂星期四、小作文、群聊反转和荒诞借钱理由。只输出一条文案正文，不要解释，不要 Markdown，不要列表，不要标题。';

  if (chatModel.includes('/qwen/')) {
    return `${base}/no_think`;
  }

  return base;
}

// Model-specific runtime flags to suppress "thinking" output (so it doesn't leak into
// the user-facing copy). Kimi takes one shape, Qwen takes another; default models need nothing.
function getChatTemplateKwargs(chatModel) {
  if (chatModel.includes('/moonshotai/kimi-')) {
    return {
      thinking: false,
      clear_thinking: true
    };
  }

  if (chatModel.includes('/qwen/')) {
    return {
      enable_thinking: false
    };
  }

  return {};
}

// First-party (@cf/) and HuggingFace (@hf/) models are invoked directly via env.AI.run;
// anything else is routed through Cloudflare's AI Gateway for caching and observability.
function getAiRunOptions(chatModel) {
  if (chatModel.startsWith('@cf/') || chatModel.startsWith('@hf/')) {
    return {};
  }

  return {
    gateway: { id: 'default' }
  };
}

// Per-IP rate limit: independent minute and day counters in KV; trip when either exceeds its limit.
// Returns null if allowed, or { scope, limit } describing which quota was exceeded.
async function isRateLimited(kv, ip) {
  if (!kv) return null;

  const { minutely, daily, minuteBucketTtlSeconds, dayBucketTtlSeconds } = CONFIG.rateLimit;
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const dayBucket = new Date(now).toISOString().slice(0, 10);
  const minuteKey = `rl:${ip}:m:${minuteBucket}`;
  const dayKey = `rl:${ip}:d:${dayBucket}`;

  // Non-atomic GET → +1 → PUT. Under bursts from one IP the count can drift and the limit slightly overshoot — acceptable here.
  const [minuteCount, dayCount] = await Promise.all([
    incrementCounter(kv, minuteKey, minuteBucketTtlSeconds),
    incrementCounter(kv, dayKey, dayBucketTtlSeconds)
  ]);

  if (dayCount > daily) return { scope: 'day', limit: daily };
  if (minuteCount > minutely) return { scope: 'minute', limit: minutely };
  return null;
}

function isLocalDevRequest(request) {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

async function incrementCounter(kv, key, expirationTtl) {
  const current = Number((await kv.get(key)) || '0');
  const next = current + 1;
  await kv.put(key, String(next), { expirationTtl });
  return next;
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

// Fire-and-forget the given async task. Uses Cloudflare's waitUntil so the worker stays
// alive long enough for it to finish, without delaying the response to the client.
// Errors are caught and logged so a failed background write can't reject the worker.
function queueBackgroundTask(context, task, errorMessage) {
  const guardedTask = Promise.resolve(task).catch((error) => {
    console.error(errorMessage, error);
  });

  if (typeof context.waitUntil === 'function') {
    context.waitUntil(guardedTask);
  }
}

// Pull the model's text out of whichever response shape it returned, clean it up, reject leaked planning.
function extractText(aiResponse) {
  const choice = aiResponse?.choices?.[0];
  const message = choice?.message;
  // "Thinking" models occasionally put the final answer in reasoning_content when finish_reason is "stop".
  const reasoningFallback =
    choice?.finish_reason === 'stop' &&
    typeof message?.reasoning_content === 'string' &&
    message.reasoning_content.length <= 360
      ? message.reasoning_content
      : '';
  // Try shapes in priority: Workers AI top-level → wrapper → OpenAI chat → legacy completion → thinking-model fallback.
  const raw = aiResponse?.response || aiResponse?.result?.response || message?.content || choice?.text || reasoningFallback;

  // Strip the noise models commonly add around their answer (code fences, bullet, "文案:" label, surrounding quotes), then cap length.
  const text = String(raw)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^文案[:：]\s*/, '')
    .replace(/^["“”]+|["“”]+$/g, '')
    .trim()
    .slice(0, 420);

  // Reject leaked chain-of-thought so generateText falls through to the corrective retry.
  if (looksLikeReasoning(text)) {
    return '';
  }

  return text;
}

// Heuristic for "the model leaked its planning instead of writing copy". Brittle but cheap;
// keywords are tuned to common Chinese LLM tells ("用户让我", "首先", "需要"...).
function looksLikeReasoning(text) {
  return /用户让我|首先|然后|需要|检查字符|我得|思考/.test(text);
}

// Best-effort detection of "Workers AI quota exhausted". Cloudflare does not publish a stable
// error code, so we string-match common keywords across every field we can find on the error.
// False positives just surface a slightly wrong user message; false negatives degrade gracefully
// to the generic "生成失败".
function isQuotaError(error) {
  const haystack = [error?.message, error?.code, error?.status, error?.statusText]
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join(' ');
  return /quota|rate[\s-]?limit|429|neuron|exceeded/i.test(haystack);
}

// Guardrail covering the two most common LLM failure modes for this domain:
//   - Flipping the V50 semantics ("我请你/我请客/我掏 50") so the speaker ends up paying.
//   - Volunteering real payment info (QR codes, account numbers, WeChat IDs).
// A match here triggers a single corrective retry in generateText.
function violatesCopyRules(text) {
  return /我请你|我请大家|我请客|我自己付|我掏\s*50|请我吃点好的|吃顿好的|凑顿好的|买\s*V50|吃\s*V50|一盒\s*V50|二维码|收款码|支付宝账号|微信号[:：]/.test(
    text
  );
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

async function measure(timing, key, callback) {
  const startedAt = performance.now();
  try {
    return await callback();
  } finally {
    timing[key] = elapsedMs(startedAt);
  }
}

function measureSync(timing, key, callback) {
  const startedAt = performance.now();
  try {
    return callback();
  } finally {
    timing[key] = elapsedMs(startedAt);
  }
}

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'Server-Timing'
  };
}
