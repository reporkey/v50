const ALLOWED_STYLES = ['随机', '发疯文学', '打工人', '恋爱脑', '学生党', '时事热梗', '玄学求助', '群聊日常'];
const MODEL = '@cf/moonshotai/kimi-k2.6';
const KEYWORD_LIMIT = 40;
const MINUTE_LIMIT = 6;
const DAILY_LIMIT = 30;
const STYLE_GUIDES = {
  发疯文学: '情绪过山车、夸张自嘲、突然破防，像群里精神状态很美丽但还能看懂。',
  打工人: '办公室、加班、会议、KPI、工位、老板、周报等语境，语气疲惫但嘴硬好笑。',
  恋爱脑: '暧昧、失恋、聊天、想你、求姻缘等情感语境，先真诚或拉扯，最后自然转向 V50。',
  学生党: '早八、ddl、考试、论文、宿舍、食堂、社团、绩点等校园语境，轻微崩溃但好笑。',
  时事热梗: '热点、新闻、财经、体育、科技等公共话题语境，只写成群聊玩笑或谣言式夸张，不要像真实新闻。',
  玄学求助: '求签、转运、寺庙、占卜、水逆、开光等玄学语境，认真胡说但要落回 50 元。',
  群聊日常: '像普通群消息、冷场吐槽、回复慢、红包、罚款、借钱、朋友互损，短一点也可以。'
};
const FORM_PATTERNS = [
  '一句话短梗：普通群消息、谐音、改成语、假通知、假红包、假罚款、假借钱。',
  '轻小作文：2-4 句，先认真铺垫，再用前文细节转向 V50。',
  '伪规则/伪解释：把关键词解释成某种离谱但能回到 50 元的理由。',
  '群聊求助：像真的在问问题、找人、报备、吐槽，最后才露出要 50 的目的。'
];
const COHERENCE_RULES = [
  'V50 必须从关键词或前文细节长出来，让读者觉得“虽然离谱但接得上”。',
  '结尾要让读者明白“我在向你/群友要 50”，可以写 V我50、借我50、转我50、你们欠我50、罚款50交我等变体。',
  'V50 是“V我50/给我转50/凑50元”的梗，不是商品名；不要写“买V50”“吃V50”“一盒V50”。',
  '不要写成“我请客”“我请你”“我请大家”“我自己付钱”“我掏 50”。',
  '不要在结尾突然新增“我是 V50 打工人”这类没有铺垫的身份标签。',
  '涉及真实公众人物或新闻时，必须明确写成梦见、群聊玩笑、编的通知、谣言式荒诞设定；不要写成真实新闻断言或第一人称亲历现场。'
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

    const limited = !isLocalDevRequest(request) && (await isRateLimited(env.RATE_LIMIT, ip));
    if (limited) {
      return json({ ok: false, error: '请求太频繁，请稍后再试' }, 429);
    }

    const resolvedStyle = resolveStyle(input.style);
    const prompt = buildPrompt({ keywords: input.keywords, style: resolvedStyle });
    const text = await generateText(env, prompt);
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

async function generateText(env, prompt) {
  const prompts = [
    prompt,
    `${prompt}\n质量修正：上一版可能把付款方向写反了。请重写一条，必须是“我向读者/群友要 50”，不能写“我请你/我请大家/我请客”。`
  ];

  for (const currentPrompt of prompts) {
    const aiResponse = await env.AI.run(MODEL, {
      messages: [
        {
          role: 'system',
          content:
            '你是一个中文互联网梗文案助手，擅长 V50 小作文和群聊反转梗。/no_think。只输出一条文案正文，不要解释，不要 Markdown，不要列表，不要标题。'
        },
        {
          role: 'user',
          content: currentPrompt
        }
      ],
      max_completion_tokens: 460,
      temperature: 0.95,
      chat_template_kwargs: getChatTemplateKwargs()
    });
    const text = extractText(aiResponse);
    if (text && !violatesCopyRules(text)) {
      return text;
    }
  }

  return '';
}

function getChatTemplateKwargs() {
  if (MODEL.includes('/moonshotai/kimi-')) {
    return {
      thinking: false,
      clear_thinking: true
    };
  }

  return {
    enable_thinking: false
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

function resolveStyle(style) {
  if (style !== '随机') return style;
  const candidates = ALLOWED_STYLES.filter((item) => item !== '随机');
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function buildPrompt({ keywords, style }) {
  const topic = keywords || '周四、打工人、精神补给、饭点';
  const styleGuide = STYLE_GUIDES[style] || STYLE_GUIDES.群聊日常;
  return [
    '/no_think',
    '请写一条中文 V50 梗文案。它可以借用疯狂星期四语境，但不必直接说“疯狂星期四”；应该像群聊里会被转发的短梗或小作文，不像广告语。',
    `主题/风格：${style}`,
    `主题/风格执行：${styleGuide}`,
    `关键词：${topic}`,
    '可选形式：',
    ...FORM_PATTERNS.map((pattern) => `- ${pattern}`),
    '连贯性要求：',
    ...COHERENCE_RULES.map((rule) => `- ${rule}`),
    '要求：20-160 个中文字符左右；必须自然包含关键词或其语义；可以一行梗，也可以小作文；如果写反转，反转必须和前文有关；结尾要有向读者索要 50 元的表达，但不强制出现“疯狂星期四”。',
    '避免：结尾只硬塞 V50；写成优惠广告；写成模板填空；过度堆叠感叹号；使用官方品牌身份或官方口吻；使用“请我吃点好的”“吃顿好的”“凑顿好的”等固定讨饭句。',
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

function violatesCopyRules(text) {
  return /我请你|我请大家|我请客|我自己付|我掏\s*50|请我吃点好的|吃顿好的|凑顿好的|买\s*V50|吃\s*V50|一盒\s*V50/.test(
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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
