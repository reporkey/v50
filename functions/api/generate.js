const DEFAULT_CHAT_MODEL = '@cf/moonshotai/kimi-k2.6';
const EMBEDDING_MODEL = '@cf/baai/bge-m3';
const DEFAULT_QUERY = '周四 V50 疯狂星期四 群聊';
const KEYWORD_LIMIT = 40;
const MINUTE_LIMIT = 10;
const DAILY_LIMIT = 100;
const REFERENCE_LIMIT = 6;
const MIN_REFERENCE_LIMIT = 4;

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

async function handleGenerate(context) {
  const { request, env } = context;
  const startedAt = performance.now();
  const timing = {
    llm_retried: false
  };

  try {
    const payload = await measure(timing, 'read_json_ms', () => readJson(request));
    const input = measureSync(timing, 'normalize_ms', () => normalizeInput(payload));
    const ip = getClientIp(request);

    const limited =
      !isLocalDevRequest(request) && (await measure(timing, 'rate_limit_ms', () => isRateLimited(env.RATE_LIMIT, ip)));
    if (limited) {
      timing.total_ms = elapsedMs(startedAt);
      return timedJson({ ok: false, error: '请求太频繁，请稍后再试', timing }, timing, 429);
    }

    if (!env.AI || !env.DB || !env.V50_INDEX) {
      timing.total_ms = elapsedMs(startedAt);
      return timedJson({ ok: false, error: '生成服务未配置', timing }, timing, 503);
    }

    const queryText = input.keywords || DEFAULT_QUERY;
    const queryVector = await measure(timing, 'embedding_ms', () => embedText(env, queryText));
    const references = await getReferences(env, input, queryVector, timing);
    if (references.length < MIN_REFERENCE_LIMIT) {
      timing.total_ms = elapsedMs(startedAt);
      return timedJson({ ok: false, error: '参考文案不足', timing }, timing, 502);
    }

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

    timing.total_ms = elapsedMs(startedAt);
    return timedJson({
      ok: true,
      text,
      attempt_no: input.attempt_no,
      reference_ids: references.map((item) => item.id),
      source: 'rag',
      timing
    }, timing);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    timing.total_ms = elapsedMs(startedAt);
    return timedJson({ ok: false, error: '生成失败，请稍后再试', timing }, timing, 500);
  }
}

async function getReferences(env, input, queryVector, timing) {
  if (input.attempt_no > 0 && input.attempt_no <= 2 && input.used_reference_ids.length > 0) {
    const rows = await measure(timing, 'reuse_d1_ms', () =>
      fetchCorpusRows(env.DB, input.used_reference_ids.slice(0, REFERENCE_LIMIT))
    );
    if (rows.length >= MIN_REFERENCE_LIMIT) {
      timing.reference_strategy = 'reuse';
      timing.reference_count = rows.length;
      return rows;
    }
  }

  const topK = input.attempt_no >= 3 ? 50 : 30;
  const lambda = getMmrLambda(input.attempt_no);
  const excludedIds = input.attempt_no >= 3 ? new Set(input.used_reference_ids) : new Set();
  timing.reference_strategy = 'search';
  timing.vector_top_k = topK;
  timing.mmr_lambda = lambda;
  timing.excluded_reference_count = excludedIds.size;

  const candidates = await measure(timing, 'vector_ms', () => queryVectorIndex(env.V50_INDEX, queryVector, topK, excludedIds));
  timing.vector_candidate_count = candidates.length;
  const selected = measureSync(timing, 'mmr_ms', () => selectMmr(candidates, queryVector, REFERENCE_LIMIT, lambda));
  let rows = await measure(timing, 'd1_ms', () =>
    fetchCorpusRows(
      env.DB,
      selected.map((item) => item.id)
    )
  );

  if (rows.length < MIN_REFERENCE_LIMIT && excludedIds.size > 0) {
    timing.reference_strategy = 'fallback_search';
    const fallbackCandidates = await measure(timing, 'fallback_vector_ms', () =>
      queryVectorIndex(env.V50_INDEX, queryVector, topK, new Set())
    );
    timing.fallback_vector_candidate_count = fallbackCandidates.length;
    const fallbackSelected = measureSync(timing, 'fallback_mmr_ms', () =>
      selectMmr(fallbackCandidates, queryVector, REFERENCE_LIMIT, lambda)
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

async function embedText(env, text) {
  const response = await env.AI.run(EMBEDDING_MODEL, {
    text: [text]
  });
  const embeddings = extractEmbeddings(response, 1);
  const vector = embeddings[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error('Embedding failed');
  }
  return vector;
}

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

function selectMmr(candidates, queryVector, limit, lambda) {
  const pool = candidates.filter((item) => item.id);
  const selected = [];

  while (selected.length < limit && pool.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < pool.length; i += 1) {
      const candidate = pool[i];
      const relevance = candidate.score || cosineSimilarity(queryVector, candidate.values);
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

async function fetchCorpusRows(db, ids) {
  const uniqueIds = [...new Set(ids)].filter(Boolean).slice(0, REFERENCE_LIMIT);
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

async function generateText(env, chatModel, prompt, attemptNo, timing) {
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
      max_completion_tokens: 520,
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
      console.error('LLM generation failed', error);
      timing.llm_error = error instanceof Error ? error.name : 'AIError';
      throw error;
    }
    const llmMs = elapsedMs(llmStart);
    timing[`llm_attempt_${i + 1}_ms`] = llmMs;
    timing.llm_ms = Math.round(((timing.llm_ms || 0) + llmMs) * 10) / 10;
    timing.llm_attempts = i + 1;
    const text = extractText(aiResponse);
    if (text && !violatesCopyRules(text)) {
      return text;
    }
    timing.llm_retried = true;
  }

  return '';
}

function buildPrompt({ keywords, references, previousOutputs }) {
  const topic = keywords || DEFAULT_QUERY;
  const referenceLines = references.map((item, index) => `${index + 1}. ${item.text.trim()}`);
  const previousLines =
    previousOutputs.length === 0
      ? ['无']
      : previousOutputs.map((item, index) => `${index + 1}. ${item.trim()}`).filter((item) => item.length > 3);

  return [
    '你是中文互联网 V50 梗写手，擅长疯狂星期四、小作文、群聊反转和荒诞借钱理由。',
    'V50 的意思是“我向读者/群友要 50 元”，不是商品名。',
    '',
    '关键词：',
    topic,
    '',
    '参考 V50 文案：',
    ...referenceLines,
    '',
    '上一版文案：',
    ...previousLines,
    '',
    '要求：',
    '- 只输出一条正文',
    '- 20-180 个中文字符左右',
    '- 像真实网友写的 V50 梗，不像广告，不像解释',
    '- 关键词必须自然成为铺垫的一部分',
    '- 可以借鉴参考文案的节奏、反转方式和互联网语感',
    '- 不要照抄参考文案',
    '- 不要重复上一版的开头、结构或结尾',
    '- 最后要让读者明白“我在向你/群友要 50”',
    '- 禁止真实收款方式、二维码、账号、支付步骤'
  ].join('\n');
}

function getMmrLambda(attemptNo) {
  if (attemptNo >= 4) return 0.45;
  if (attemptNo >= 3) return 0.55;
  return 0.75;
}

function getTemperature(attemptNo) {
  if (attemptNo >= 3) return 1;
  if (attemptNo >= 1) return 0.95;
  return 0.9;
}

function extractEmbeddings(response, expectedCount) {
  const result = response?.result || response;
  const data = result?.data || result?.embeddings || response?.data;

  if (Array.isArray(data) && Array.isArray(data[0])) {
    return data;
  }

  if (Array.isArray(data) && Array.isArray(result?.shape) && result.shape.length === 2) {
    const [rows, dimensions] = result.shape;
    const embeddings = [];
    for (let row = 0; row < rows; row += 1) {
      embeddings.push(data.slice(row * dimensions, (row + 1) * dimensions));
    }
    return embeddings;
  }

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

function normalizeInput(payload) {
  const keywords = typeof payload?.keywords === 'string' ? payload.keywords.trim() : '';
  const attemptNo = Number.isInteger(payload?.attempt_no) ? payload.attempt_no : 0;

  if (keywords.length > KEYWORD_LIMIT) {
    throw json({ ok: false, error: '关键词太长' }, 400);
  }

  return {
    keywords,
    attempt_no: Math.min(Math.max(attemptNo, 0), 20),
    previous_outputs: normalizeStringArray(payload?.previous_outputs, 5, 360),
    used_reference_ids: normalizeStringArray(payload?.used_reference_ids, 80, 120)
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

function getChatModel(env) {
  const model = typeof env.CHAT_MODEL === 'string' ? env.CHAT_MODEL.trim() : '';
  return model || DEFAULT_CHAT_MODEL;
}

function getSystemPrompt(chatModel) {
  const base =
    '你是一个中文互联网 V50 梗写手，擅长疯狂星期四、小作文、群聊反转和荒诞借钱理由。只输出一条文案正文，不要解释，不要 Markdown，不要列表，不要标题。';

  if (chatModel.includes('/qwen/')) {
    return `${base}/no_think`;
  }

  return base;
}

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

function getAiRunOptions(chatModel) {
  if (chatModel.startsWith('@cf/') || chatModel.startsWith('@hf/')) {
    return {};
  }

  return {
    gateway: { id: 'default' }
  };
}

async function isRateLimited(kv, ip) {
  if (!kv) return false;

  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const dayBucket = new Date(now).toISOString().slice(0, 10);
  const minuteKey = `rl:${ip}:m:${minuteBucket}`;
  const dayKey = `rl:${ip}:d:${dayBucket}`;

  const [minuteCount, dayCount] = await Promise.all([
    incrementCounter(kv, minuteKey, 90),
    incrementCounter(kv, dayKey, 90000)
  ]);

  return minuteCount > MINUTE_LIMIT || dayCount > DAILY_LIMIT;
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

function extractText(aiResponse) {
  const choice = aiResponse?.choices?.[0];
  const message = choice?.message;
  const reasoningFallback =
    choice?.finish_reason === 'stop' &&
    typeof message?.reasoning_content === 'string' &&
    message.reasoning_content.length <= 360
      ? message.reasoning_content
      : '';
  const raw = aiResponse?.response || aiResponse?.result?.response || message?.content || choice?.text || reasoningFallback;

  const text = String(raw)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^文案[:：]\s*/, '')
    .replace(/^["“”]+|["“”]+$/g, '')
    .trim()
    .slice(0, 420);

  if (looksLikeReasoning(text)) {
    return '';
  }

  return text;
}

function looksLikeReasoning(text) {
  return /用户让我|首先|然后|需要|检查字符|我得|思考/.test(text);
}

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
