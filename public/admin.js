const ADMIN_CONFIG = window.V50_CONFIG.admin;

const tokenGate = document.getElementById('tokenGate');
const tokenForm = document.getElementById('tokenForm');
const tokenInput = document.getElementById('tokenInput');
const tokenError = document.getElementById('tokenError');
const queueSection = document.getElementById('queue');
const queueList = document.getElementById('queueList');
const refreshBtn = document.getElementById('queueRefresh');
const tokenClearBtn = document.getElementById('tokenClear');
const toastHost = document.getElementById('toastHost');

let adminToken = localStorage.getItem(ADMIN_CONFIG.tokenStorageKey) || '';
let loading = false;

function showToast(message, kind) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind || 'info'}`;
  toast.textContent = message;
  toastHost.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, ADMIN_CONFIG.toastTimeoutMs);
}

function showGate() {
  tokenGate.hidden = false;
  queueSection.hidden = true;
}

function showQueue() {
  tokenGate.hidden = true;
  queueSection.hidden = false;
  loadQueue();
}

function setToken(value) {
  adminToken = value;
  if (value) {
    localStorage.setItem(ADMIN_CONFIG.tokenStorageKey, value);
  } else {
    localStorage.removeItem(ADMIN_CONFIG.tokenStorageKey);
  }
}

async function probeToken(token) {
  // Probe by attempting an approve with a guaranteed-missing id.
  // 401 means wrong token. 404/400/409 from the server mean we passed
  // auth and reached the action handler — token is valid.
  // 5xx means the server is unconfigured (e.g., ADMIN_TOKEN unbound) —
  // treat as a probe failure so the gate doesn't appear to pass.
  try {
    const response = await fetch('/api/admin/approve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': token
      },
      body: JSON.stringify({ id: 'v50_probe_invalid', action: 'approve' })
    });
    if (response.status === 401) return false;
    if (response.status >= 500) return false;
    return response.status >= 400 && response.status < 500;
  } catch {
    return false;
  }
}

async function loadQueue() {
  if (loading) return;
  loading = true;
  queueList.innerHTML = '<li class="empty">加载中...</li>';

  try {
    const response = await fetch('/api/corpus/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'pending', page: 1, page_size: ADMIN_CONFIG.pageSize })
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error('list failed');

    if (!payload.items || payload.items.length === 0) {
      queueList.innerHTML = '<li class="empty">队列空空如也。</li>';
    } else {
      queueList.innerHTML = '';
      payload.items.forEach((item) => queueList.append(renderQueueItem(item)));
    }
  } catch (error) {
    console.error(error);
    queueList.innerHTML = `<li class="empty">${ADMIN_CONFIG.messages.generic}</li>`;
  } finally {
    loading = false;
  }
}

function renderQueueItem(item) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.dataset.id = item.id;

  const text = document.createElement('p');
  text.className = 'queue-text';
  text.textContent = item.text;

  const meta = document.createElement('p');
  meta.className = 'queue-meta';
  const author = document.createElement('span');
  author.textContent = `作者：${item.author || '匿名'}`;
  const time = document.createElement('span');
  const submittedAt = item.submitted_at || item.created_at;
  time.textContent = submittedAt ? `投稿：${submittedAt}` : '';
  meta.append(author, time);

  const actions = document.createElement('div');
  actions.className = 'queue-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn primary';
  approveBtn.type = 'button';
  approveBtn.textContent = '通过';
  approveBtn.addEventListener('click', () => act(item.id, 'approve', approveBtn, li));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn ghost danger';
  deleteBtn.type = 'button';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', () => act(item.id, 'delete', deleteBtn, li));

  actions.append(approveBtn, deleteBtn);
  li.append(text, meta, actions);
  return li;
}

async function act(id, action, sourceBtn, li) {
  if (sourceBtn.disabled) return;
  const rowButtons = Array.from(li.querySelectorAll('button'));
  const originalLabels = new Map(rowButtons.map((btn) => [btn, btn.textContent]));
  rowButtons.forEach((btn) => { btn.disabled = true; });
  sourceBtn.textContent = action === 'approve' ? '处理中...' : '删除中...';

  const restore = () => {
    rowButtons.forEach((btn) => {
      btn.disabled = false;
      const original = originalLabels.get(btn);
      if (original !== undefined) btn.textContent = original;
    });
  };

  try {
    const response = await fetch('/api/admin/approve', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': adminToken
      },
      body: JSON.stringify({ id, action })
    });
    let payload = null;
    try { payload = await response.json(); } catch {}

    if (response.status === 401) {
      setToken('');
      showToast(ADMIN_CONFIG.messages.unauthorized, 'error');
      showGate();
      return;
    }
    if (!response.ok || !payload?.ok) {
      const isEmbedError = payload?.error === 'embed_failed' || payload?.error === 'upsert_failed';
      const message = isEmbedError
        ? ADMIN_CONFIG.messages.embedFailed
        : ADMIN_CONFIG.messages.generic;
      showToast(message, 'error');
      restore();
      return;
    }

    showToast(
      action === 'approve' ? ADMIN_CONFIG.messages.approved : ADMIN_CONFIG.messages.deleted,
      'success'
    );
    li.remove();
    if (queueList.children.length === 0) {
      queueList.innerHTML = '<li class="empty">队列空空如也。</li>';
    }
  } catch (error) {
    console.error(error);
    showToast(ADMIN_CONFIG.messages.generic, 'error');
    restore();
  }
}

tokenForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = tokenInput.value.trim();
  if (!value) return;
  const valid = await probeToken(value);
  if (!valid) {
    tokenError.textContent = ADMIN_CONFIG.messages.unauthorized;
    tokenError.hidden = false;
    return;
  }
  setToken(value);
  tokenError.hidden = true;
  tokenInput.value = '';
  showQueue();
});

refreshBtn.addEventListener('click', loadQueue);
tokenClearBtn.addEventListener('click', () => {
  setToken('');
  tokenInput.value = '';
  showGate();
});

if (adminToken) {
  showQueue();
} else {
  showGate();
}
