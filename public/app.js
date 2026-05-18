const HISTORY_KEY = 'v50-copy-history';
const MAX_HISTORY = 5;
const API_ERROR_MESSAGE = '生成失败，请稍后再试';
const RATE_LIMIT_MESSAGE = '请求太频繁，请稍后再试';

const keywordsEl = document.getElementById('keywords');
const styleOptionsEl = document.getElementById('styleOptions');
const resultTextEl = document.getElementById('resultText');
const historyListEl = document.getElementById('historyList');
const copyFeedbackEl = document.getElementById('copyFeedback');

const generateBtn = document.getElementById('generateBtn');
const copyBtn = document.getElementById('copyBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

let selectedStyle = '随机';
let hasGenerated = false;
let isGenerating = false;
let currentCopyText = '';

const styleTemplates = {
  发疯文学: [
    '今天不为别的，就为{kw}这点执念。V我50，我立刻从人类进化成快乐尖叫鸡。',
    '我盯着{kw}看了三小时，脑子只剩一句：快V我50，不然我要对空气发表千字疯言。',
    '谁懂啊，{kw}把我CPU干烧了。V我50，让我在薯条香气里原地重启。'
  ],
  打工人: [
    '早八晚九还在追{kw}，工位像战场。V我50，午休给自己加一口脆皮士气。',
    '本月KPI追着我跑，{kw}又临时加码。V我50，让打工人续一条命。',
    '我不是在搬砖，我是在为{kw}打补丁。V我50，下午会我就敢第一个发言。'
  ],
  恋爱脑: [
    '今天本来想聊{kw}，结果越聊越想你。V我50，我去买点东西冷静一下。',
    '你说{kw}不重要，可我连标点都想解读。V我50，恋爱脑今天需要维修费。',
    '我把{kw}看了三遍，还是没看懂你到底喜不喜欢我。V我50，我去求个答案。'
  ],
  学生党: [
    '早八点名，{kw}还没写完，老师说年轻人要有朝气。V我50，我买杯豆浆假装有。',
    '宿舍灯一关，我和{kw}同时沉默。V我50，今晚的论文靠一口热量续命。',
    '绩点不爱我，{kw}也不放过我。V我50，我去食堂窗口买点尊严。'
  ],
  时事热梗: [
    '群里刚传{kw}，我认真分析了三分钟，结论是信息量太大。V我50，我去买杯饮料压压惊。',
    '关于{kw}，本人目前没有内部消息，只有一个外部需求：V我50。',
    '别问{kw}是真是假，问就是群聊观察员需要经费。V我50，我继续帮大家盯盘。'
  ],
  玄学求助: [
    '刚给{kw}抽了一签，签上写着四个字：先V我50。',
    '大师说{kw}最近缺一点火候。V我50，我去红色圣地替你补补运。',
    '水逆、犯困、{kw}不顺，统称能量不足。V我50，我现场做法恢复。'
  ],
  群聊日常: [
    '今日份精神状态：被{kw}拿捏，但还能笑着说“问题不大”。V我50，速来点赞续命。',
    '朋友们，{kw}这事我先冲了。V我50，评论区见证我从嘴硬到真香。',
    '打卡第N天：和{kw}斗智斗勇。V我50，这条朋友圈就当我的电子饭票。'
  ],
  通用: [
    '周四了，灵魂在排队等脆皮。V我50，让我把这一口快乐写成史诗。',
    '生活不一定容易，但V我50会让我嘴角先上扬三厘米。',
    '今日K线全红不如我手里这份黄金脆响。V我50，马上切换好心情模式。'
  ]
};

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function resolveStyle(style) {
  if (style === '随机') {
    const candidates = ['发疯文学', '打工人', '恋爱脑', '学生党', '时事热梗', '玄学求助', '群聊日常'];
    return pickRandom(candidates);
  }
  return style;
}

function mockGenerateCopy({ keywords, style }) {
  const resolvedStyle = resolveStyle(style);
  const source = styleTemplates[resolvedStyle] || styleTemplates.通用;
  const template = pickRandom(source);
  const kw = keywords && keywords.trim() ? keywords.trim() : '今天的周四气氛';

  if (keywords && keywords.trim()) {
    return template.replaceAll('{kw}', kw);
  }

  const generic = pickRandom(styleTemplates.通用);
  return `${generic} ${template.replaceAll('{kw}', kw)}`;
}

async function generateCopy({ keywords, style }) {
  if (shouldUseMockGenerator()) {
    return mockGenerateCopy({ keywords, style });
  }

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      keywords: keywords.trim(),
      style
    })
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload?.ok || typeof payload.text !== 'string' || !payload.text.trim()) {
    const message = response.status === 429 ? payload?.error || RATE_LIMIT_MESSAGE : API_ERROR_MESSAGE;
    throw new Error(message);
  }

  return payload.text.trim();
}

function shouldUseMockGenerator() {
  const params = new URLSearchParams(window.location.search);
  return window.location.protocol === 'file:' || params.get('mock') === '1';
}

function loadHistory() {
  const raw = localStorage.getItem(HISTORY_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

function renderHistory(history) {
  historyListEl.innerHTML = '';
  if (history.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '暂无历史，先生成一条试试。';
    historyListEl.append(li);
    return;
  }

  history.forEach((item) => {
    const li = document.createElement('li');
    li.textContent = item;
    historyListEl.append(li);
  });
}

function addToHistory(copyText) {
  const history = loadHistory();
  const next = [copyText, ...history.filter((x) => x !== copyText)].slice(0, MAX_HISTORY);
  saveHistory(next);
  renderHistory(next);
}

async function handleGenerate() {
  if (isGenerating) return;

  const keywords = keywordsEl.value;
  const style = selectedStyle;

  isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = '生成中...';
  copyFeedbackEl.textContent = '';

  try {
    const text = await generateCopy({ keywords, style });
    resultTextEl.textContent = text;
    currentCopyText = text;
    hasGenerated = true;
    addToHistory(text);
  } catch (error) {
    currentCopyText = '';
    const message = error?.message === RATE_LIMIT_MESSAGE ? RATE_LIMIT_MESSAGE : API_ERROR_MESSAGE;
    resultTextEl.textContent = message;
  } finally {
    isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = hasGenerated ? '再来一条' : '生成文案';
  }
}

async function copyCurrentResult() {
  const text = currentCopyText.trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    copyFeedbackEl.textContent = '已复制';
    setTimeout(() => {
      copyFeedbackEl.textContent = '';
    }, 1400);
  } catch {
    copyFeedbackEl.textContent = '复制失败，请手动复制';
  }
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory([]);
}

function handleStyleSelect(event) {
  const button = event.target.closest('.style-chip');
  if (!button) return;

  selectedStyle = button.dataset.style;
  styleOptionsEl.querySelectorAll('.style-chip').forEach((chip) => {
    chip.classList.toggle('active', chip === button);
  });
}

generateBtn.addEventListener('click', handleGenerate);
copyBtn.addEventListener('click', copyCurrentResult);
clearHistoryBtn.addEventListener('click', clearHistory);
styleOptionsEl.addEventListener('click', handleStyleSelect);

renderHistory(loadHistory());
