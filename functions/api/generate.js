const ALLOWED_STYLES = ['随机', '发疯文学', '打工人', '深情', '朋友圈', '荒诞'];
const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';
const KEYWORD_LIMIT = 40;
const MINUTE_LIMIT = 6;
const DAILY_LIMIT = 30;
const STYLE_GUIDES = {
  发疯文学: '情绪过山车、夸张自嘲、像在群里突然崩溃又突然快乐，句子可以短促但不要乱码。',
  打工人: '办公室、加班、会议、KPI、工位、老板、周报等打工人语境，语气疲惫但嘴硬好笑。',
  深情: '先像失恋、告白、回忆或人生感悟，语气认真温柔，最后忽然露出真实目的。',
  朋友圈: '像一条真实朋友圈/群聊动态，有日常细节、轻微自嘲和求互动感，别像广告。',
  荒诞: '伪科学、怪通知、离谱设定、宇宙级因果或一本正经的胡说，逻辑可以跳但要读得懂。'
};
const OPENING_ANGLES = [
  '伪装成正式通知、温馨提醒、活动公告、招聘/接单信息、技术求助、人生建议、情感倾诉、科普研究、朋友圈近况中的一种。',
  '先让读者以为主题是工作、恋爱、天气、学习、游戏、健康、生活危机或玄学事件。',
  '中段加入 2-4 个具体细节，让铺垫看起来像真的。',
  '最后 1 句突然反转到“今天疯狂星期四 / V我50 / 请我吃点好的”，形成群聊包袱。'
];

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
            '你是一个中文互联网梗文案助手，擅长“疯狂星期四 / V50”小作文。/no_think。只输出一条文案正文，不要解释，不要 Markdown，不要列表，不要标题。'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 460,
      temperature: 0.95,
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
  const topic = keywords || '疯狂星期四、V50、打工人、快乐补给';
  const styleGuide = STYLE_GUIDES[style] || STYLE_GUIDES.朋友圈;
  return [
    '/no_think',
    '请写一条中文“疯狂星期四 / V50”梗文案。它应该像群聊里会被转发的小作文，不像广告语。',
    `风格：${style}`,
    `风格执行：${styleGuide}`,
    `关键词：${topic}`,
    '结构参考：',
    ...OPENING_ANGLES.map((angle) => `- ${angle}`),
    '要求：80-180 个中文字符左右；必须自然包含关键词或其语义；要有铺垫、转折、最后的包袱；结尾必须出现“疯狂星期四”或“V我50”之一，最好两者都有。',
    '避免：开头就暴露 V50；写成优惠广告；写成模板填空；过度堆叠感叹号；使用官方品牌身份或官方口吻。',
    '禁止：提供真实转账方式、二维码、账号、支付步骤；仇恨、骚扰、露骨内容。',
    '只输出文案正文。'
  ].join('\n');
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
    .slice(0, 360);

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
