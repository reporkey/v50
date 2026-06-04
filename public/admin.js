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
const selectAllBox = document.getElementById('queueSelectAll');
const selectionInfo = document.getElementById('queueSelectionInfo');
const bulkApproveBtn = document.getElementById('queueBulkApprove');
const bulkDeleteBtn = document.getElementById('queueBulkDelete');

let adminToken = localStorage.getItem(ADMIN_CONFIG.tokenStorageKey) || '';
let loading = false;
let bulkInFlight = false;
const selected = new Set();

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
  selected.clear();
  queueList.innerHTML = '<li class="empty">加载中...</li>';

  try {
    const response = await fetch('/api/corpus/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'queue', page: 1, page_size: ADMIN_CONFIG.pageSize })
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
    updateSelectionUI();
  }
}

function updateSelectionUI() {
  const checks = Array.from(queueList.querySelectorAll('.queue-item-check'));
  const count = selected.size;
  selectionInfo.textContent = `已选 ${count} 条`;
  if (checks.length === 0) {
    selectAllBox.checked = false;
    selectAllBox.indeterminate = false;
    selectAllBox.disabled = true;
  } else {
    selectAllBox.disabled = bulkInFlight;
    selectAllBox.checked = checks.every((c) => c.checked);
    selectAllBox.indeterminate = !selectAllBox.checked && count > 0;
  }
  const noSelection = count === 0;
  bulkApproveBtn.disabled = bulkInFlight || noSelection;
  bulkDeleteBtn.disabled = bulkInFlight || noSelection;
}

function toggleSelected(id, checked) {
  if (checked) selected.add(id);
  else selected.delete(id);
  updateSelectionUI();
}

function renderQueueItem(item) {
  const li = document.createElement('li');
  li.className = 'queue-item';
  li.dataset.id = item.id;

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'queue-item-check';
  check.setAttribute('aria-label', '选择此条');
  check.addEventListener('change', () => toggleSelected(item.id, check.checked));

  const body = document.createElement('div');
  body.className = 'queue-item-body';

  const text = document.createElement('p');
  text.className = 'queue-text';
  text.textContent = item.text;

  // 'indexing' = approved but the background embed hasn't finished (or failed).
  // Such rows stay in the queue so the admin can see and retry them.
  const isIndexing = item.status === 'indexing';

  const meta = document.createElement('p');
  meta.className = 'queue-meta';
  const author = document.createElement('span');
  author.textContent = `作者：${item.author || '匿名'}`;
  const statusEl = document.createElement('span');
  statusEl.className = `queue-status queue-status-${item.status}`;
  statusEl.textContent = isIndexing ? '索引中（未完成）' : '待审核';
  const time = document.createElement('span');
  const submittedAt = item.submitted_at || item.created_at;
  time.textContent = submittedAt ? `投稿：${submittedAt}` : '';
  meta.append(author, statusEl, time);

  const actions = document.createElement('div');
  actions.className = 'queue-actions';

  const approveBtn = document.createElement('button');
  approveBtn.className = 'btn primary';
  approveBtn.type = 'button';
  approveBtn.textContent = isIndexing ? '重试索引' : '通过';
  approveBtn.addEventListener('click', () => act(item.id, 'approve', approveBtn, li));

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'btn ghost danger';
  deleteBtn.type = 'button';
  deleteBtn.textContent = '删除';
  deleteBtn.addEventListener('click', () => act(item.id, 'delete', deleteBtn, li));

  actions.append(approveBtn, deleteBtn);
  body.append(text, meta, actions);
  li.append(check, body);
  return li;
}

function removeRow(id) {
  const li = queueList.querySelector(`li[data-id="${cssEscape(id)}"]`);
  if (li) li.remove();
  selected.delete(id);
  if (queueList.children.length === 0) {
    queueList.innerHTML = '<li class="empty">队列空空如也。</li>';
  }
}

function cssEscape(value) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : String(value).replace(/(["\\])/g, '\\$1');
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
      const isEmbedError = ['embed_failed', 'upsert_failed', 'promote_failed', 'binding_missing']
        .includes(payload?.error);
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
    removeRow(id);
    updateSelectionUI();
  } catch (error) {
    console.error(error);
    showToast(ADMIN_CONFIG.messages.generic, 'error');
    restore();
  }
}

async function bulkAct(action) {
  if (bulkInFlight) return;
  if (selected.size === 0) return;
  const ids = Array.from(selected);

  if (action === 'delete' && !window.confirm(`确定要删除选中的 ${ids.length} 条？`)) {
    return;
  }

  bulkInFlight = true;
  bulkApproveBtn.classList.add('is-loading');
  bulkDeleteBtn.classList.add('is-loading');
  updateSelectionUI();

  let success = 0;
  let unauthorized = false;
  const failures = [];

  await Promise.all(
    ids.map(async (id) => {
      try {
        const response = await fetch('/api/admin/approve', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Admin-Token': adminToken
          },
          body: JSON.stringify({ id, action })
        });
        if (response.status === 401) {
          unauthorized = true;
          return;
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) {
          failures.push({ id, error: payload?.error || `http_${response.status}` });
          return;
        }
        success += 1;
        removeRow(id);
      } catch (error) {
        console.error(error);
        failures.push({ id, error: 'network' });
      }
    })
  );

  bulkInFlight = false;
  bulkApproveBtn.classList.remove('is-loading');
  bulkDeleteBtn.classList.remove('is-loading');

  if (unauthorized) {
    setToken('');
    showToast(ADMIN_CONFIG.messages.unauthorized, 'error');
    showGate();
    return;
  }

  const verb = action === 'approve' ? '通过' : '删除';
  if (failures.length === 0) {
    showToast(`已${verb} ${success} 条`, 'success');
  } else if (success === 0) {
    showToast(`${verb}失败，共 ${failures.length} 条`, 'error');
  } else {
    showToast(`已${verb} ${success} 条，失败 ${failures.length} 条`, 'error');
  }

  updateSelectionUI();
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

selectAllBox.addEventListener('change', () => {
  const checks = Array.from(queueList.querySelectorAll('.queue-item-check'));
  if (checks.length === 0) return;
  const shouldSelect = selectAllBox.checked;
  checks.forEach((check) => {
    check.checked = shouldSelect;
    const li = check.closest('.queue-item');
    if (!li) return;
    if (shouldSelect) selected.add(li.dataset.id);
    else selected.delete(li.dataset.id);
  });
  updateSelectionUI();
});

bulkApproveBtn.addEventListener('click', () => bulkAct('approve'));
bulkDeleteBtn.addEventListener('click', () => bulkAct('delete'));

if (adminToken) {
  showQueue();
} else {
  showGate();
}
