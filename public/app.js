const HISTORY_KEY = 'v50-copy-history';
const MAX_HISTORY = 5;
const API_ERROR_MESSAGE = '生成失败，请稍后再试';
const RATE_LIMIT_MESSAGE = '请求太频繁，请稍后再试';

const keywordsEl = document.getElementById('keywords');
const resultTextEl = document.getElementById('resultText');
const historyListEl = document.getElementById('historyList');
const copyFeedbackEl = document.getElementById('copyFeedback');

const generateBtn = document.getElementById('generateBtn');
const copyBtn = document.getElementById('copyBtn');
const clearHistoryBtn = document.getElementById('clearHistoryBtn');

let hasGenerated = false;
let isGenerating = false;
let currentCopyText = '';
let lastKeywords = '';
let attemptNo = 0;
let previousOutputs = [];
let usedReferenceIds = [];

function pickRandom(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function mockGenerateCopy({ keywords, attempt_no: nextAttemptNo }) {
  const templates = [
    '今天本来想认真聊{kw}，但我的精神状态刚走到门口就被星期四拦住了。V我50，我去给它赎回来。',
    '关于{kw}这件事，我已经想出三套解决方案：冷静、沟通、以及你现在V我50让我先吃点。',
    '通知：经群聊临时研究决定，{kw}造成的精神损耗统一按50元报销，请自觉转给我。',
    '我和{kw}之间只差一个答案，和肯德基之间只差50块。先解决比较容易的那个，V我50。',
    '别问{kw}怎么处理，问就是本人正在低电量模式。V我50，充完这口脆皮我继续嘴硬。'
  ];
  const kw = keywords && keywords.trim() ? keywords.trim() : '今天的周四气氛';
  const text = pickRandom(templates).replaceAll('{kw}', kw);

  return {
    ok: true,
    text,
    attempt_no: nextAttemptNo,
    reference_ids: [],
    source: 'mock'
  };
}

async function generateCopy({ keywords, attempt_no, previous_outputs, used_reference_ids }) {
  if (shouldUseMockGenerator()) {
    return mockGenerateCopy({ keywords, attempt_no });
  }

  const response = await fetch('/api/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      keywords: keywords.trim(),
      attempt_no,
      previous_outputs,
      used_reference_ids
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

  return {
    ok: true,
    text: payload.text.trim(),
    attempt_no: Number.isInteger(payload.attempt_no) ? payload.attempt_no : attempt_no,
    reference_ids: Array.isArray(payload.reference_ids) ? payload.reference_ids : [],
    source: payload.source || 'rag',
    timing: payload.timing || null
  };
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

  const keywords = keywordsEl.value.trim();
  const isRegenerate = hasGenerated && keywords === lastKeywords;
  const nextAttemptNo = isRegenerate ? attemptNo + 1 : 0;
  const nextPreviousOutputs =
    isRegenerate && currentCopyText ? [...previousOutputs, currentCopyText].slice(-5) : [];
  const requestReferenceIds = isRegenerate ? usedReferenceIds : [];

  isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = '生成中...';
  copyFeedbackEl.textContent = '';

  try {
    const payload = await generateCopy({
      keywords,
      attempt_no: nextAttemptNo,
      previous_outputs: nextPreviousOutputs,
      used_reference_ids: requestReferenceIds
    });
    if (payload.timing) {
      console.info('V50 generation timing', payload.timing);
    }
    const text = payload.text;
    resultTextEl.textContent = text;
    currentCopyText = text;
    hasGenerated = true;
    lastKeywords = keywords;
    attemptNo = payload.attempt_no;
    previousOutputs = nextPreviousOutputs;
    usedReferenceIds = mergeReferenceIds(requestReferenceIds, payload.reference_ids);
    addToHistory(text);
  } catch (error) {
    currentCopyText = '';
    const message = error?.message === RATE_LIMIT_MESSAGE ? RATE_LIMIT_MESSAGE : API_ERROR_MESSAGE;
    resultTextEl.textContent = message;
  } finally {
    isGenerating = false;
    generateBtn.disabled = false;
    updateGenerateButtonLabel();
  }
}

async function copyCurrentResult() {
  const text = currentCopyText.trim();
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    saveCopiedOutput(text);
    copyFeedbackEl.textContent = '已复制';
    setTimeout(() => {
      copyFeedbackEl.textContent = '';
    }, 1400);
  } catch {
    copyFeedbackEl.textContent = '复制失败，请手动复制';
  }
}

function mergeReferenceIds(existing, incoming) {
  return [...new Set([...(existing || []), ...(incoming || [])])].filter(Boolean).slice(-60);
}

function saveCopiedOutput(text) {
  if (shouldUseMockGenerator()) return;

  fetch('/api/copy', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      keywords: lastKeywords,
      copied_text: text,
      attempt_no: attemptNo,
      reference_ids: usedReferenceIds,
      previous_outputs: previousOutputs
    })
  }).catch(() => {});
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory([]);
}

function updateGenerateButtonLabel() {
  if (!hasGenerated || keywordsEl.value.trim() !== lastKeywords) {
    generateBtn.textContent = '生成文案';
    return;
  }

  generateBtn.textContent = '再来一条';
}

generateBtn.addEventListener('click', handleGenerate);
copyBtn.addEventListener('click', copyCurrentResult);
clearHistoryBtn.addEventListener('click', clearHistory);
keywordsEl.addEventListener('input', updateGenerateButtonLabel);

renderHistory(loadHistory());
