const ALLOWED_STYLES = ['随机', '发疯文学', '打工人', '深情', '朋友圈', '荒诞'];
const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const KEYWORD_LIMIT = 40;
const MINUTE_LIMIT = 6;
const DAILY_LIMIT = 30;

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

  try {
    const payload = await readJson(request);
    const input = normalizeInput(payload);
    const ip = getClientIp(request);

    const limited = await isRateLimited(env.RATE_LIMIT, ip);
    if (limited) {
      return json({ ok: false, error: '请求太频繁，请稍后再试' }, 429);
    }

    const resolvedStyle = resolveStyle(input.style);
    const prompt = buildPrompt({ keywords: input.keywords, style: resolvedStyle });
    const aiResponse = await env.AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content:
            '你是一个中文互联网短文案助手。/no_think。只输出一条文案，不要解释，不要 Markdown，不要列表，不要标题。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 360,
      temperature: 0.9,
      chat_template_kwargs: {
        enable_thinking: false
      }
    });
    const text = extractText(aiResponse);
    if (!text) {
      return json({ ok: false, error: '生成失败，请稍后再试' }, 502);
    }

    return json({ ok: true, text, style: resolvedStyle, source: 'ai' });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return json({ ok: false, error: '生成失败，请稍后再试' }, 500);
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
  const keywords = typeof payload?.keywords === 'string' ? payload.keywords.trim() : '';
  const style = typeof payload?.style === 'string' ? payload.style.trim() : '';

  if (keywords.length > KEYWORD_LIMIT) {
    throw json({ ok: false, error: '关键词太长' }, 400);
  }

  if (!ALLOWED_STYLES.includes(style)) {
    throw json({ ok: false, error: '无效风格' }, 400);
  }

  return { keywords, style };
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

function resolveStyle(style) {
  if (style !== '随机') return style;
  const candidates = ALLOWED_STYLES.filter((item) => item !== '随机');
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function buildPrompt({ keywords, style }) {
  const topic = keywords || '周四、快乐、想吃点好的';
  return [
    '/no_think',
    '请写一条中文“V50 / 疯狂星期四”风格短文案。',
    `风格：${style}`,
    `关键词：${topic}`,
    '要求：40-100 个中文字符左右，自然、好笑、有网感。',
    '禁止：自称官方账号；使用官方品牌口吻；提供真实转账方式、二维码、账号、支付指令；仇恨、骚扰、露骨内容。',
    '只输出文案正文。'
  ].join('\n');
}

function extractText(aiResponse) {
  const choice = aiResponse?.choices?.[0];
  const message = choice?.message;
  const reasoningFallback =
    choice?.finish_reason === 'stop' &&
    typeof message?.reasoning_content === 'string' &&
    message.reasoning_content.length <= 220
      ? message.reasoning_content
      : '';
  const raw = aiResponse?.response || aiResponse?.result?.response || message?.content || choice?.text || reasoningFallback;

  const text = String(raw)
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^[-*]\s*/, '')
    .replace(/^文案[:：]\s*/, '')
    .replace(/^["“”]+|["“”]+$/g, '')
    .trim()
    .slice(0, 220);

  if (looksLikeReasoning(text)) {
    return '';
  }

  return text;
}

function looksLikeReasoning(text) {
  return /用户让我|首先|然后|需要|检查字符|我得|思考/.test(text);
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
