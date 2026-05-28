const CORPUS_CONFIG = window.V50_CONFIG.corpus;

const searchEl = document.getElementById('corpusSearch');
const pillsEl = document.querySelectorAll('.corpus-card .pill');
const listEl = document.getElementById('corpusList');
const prevBtn = document.getElementById('corpusPrev');
const nextBtn = document.getElementById('corpusNext');
const pageInfoEl = document.getElementById('corpusPageInfo');

const state = {
  q: '',
  status: 'approved',
  page: 1,
  pageSize: CORPUS_CONFIG.pageSize,
  total: 0,
  loading: false,
  loaded: false
};

let searchDebounceTimer = null;

async function loadPage() {
  if (state.loading) return;
  state.loading = true;
  listEl.innerHTML = '<li class="empty">加载中...</li>';

  try {
    const response = await fetch('/api/corpus/list', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: state.q,
        status: state.status,
        page: state.page,
        page_size: state.pageSize
      })
    });
    const payload = await response.json();
    if (!response.ok || !payload?.ok) throw new Error('list failed');
    renderList(payload.items, payload.total);
  } catch (error) {
    console.error(error);
    listEl.innerHTML = `<li class="empty">${CORPUS_CONFIG.messages.browseError}</li>`;
  } finally {
    state.loading = false;
    state.loaded = true;
  }
}

function renderList(items, total) {
  state.total = total;
  if (!items || items.length === 0) {
    listEl.innerHTML = '<li class="empty">这里还什么都没有。</li>';
  } else {
    listEl.innerHTML = '';
    items.forEach((item) => listEl.append(renderItem(item)));
  }
  updatePager();
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = `corpus-item status-${item.status}`;

  const text = document.createElement('p');
  text.className = 'corpus-text';
  text.textContent = item.text;

  const meta = document.createElement('p');
  meta.className = 'corpus-meta';
  const author = document.createElement('span');
  author.className = 'corpus-author';
  author.textContent = item.author || CORPUS_CONFIG.submitDefaultAuthor;
  const status = document.createElement('span');
  status.className = `corpus-status corpus-status-${item.status}`;
  status.textContent = CORPUS_CONFIG.statusLabels[item.status] || item.status;
  meta.append(author, status);

  li.append(text, meta);
  return li;
}

function updatePager() {
  const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
  pageInfoEl.textContent = `第 ${state.page} 页 / 共 ${totalPages} 页`;
  prevBtn.disabled = state.page <= 1;
  nextBtn.disabled = state.page >= totalPages;
}

function selectStatus(status) {
  if (state.status === status) return;
  state.status = status;
  state.page = 1;
  pillsEl.forEach((pill) => pill.classList.toggle('active', pill.dataset.status === status));
  loadPage();
}

function onSearchInput() {
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    const next = searchEl.value.trim();
    if (next === state.q) return;
    state.q = next;
    state.page = 1;
    loadPage();
  }, 260);
}

prevBtn.addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    loadPage();
  }
});
nextBtn.addEventListener('click', () => {
  const totalPages = Math.max(Math.ceil(state.total / state.pageSize), 1);
  if (state.page < totalPages) {
    state.page += 1;
    loadPage();
  }
});
pillsEl.forEach((pill) => {
  pill.addEventListener('click', () => selectStatus(pill.dataset.status));
});
searchEl.addEventListener('input', onSearchInput);

document.addEventListener('v50:tabchange', (event) => {
  if (event.detail?.tab === 'corpus' && !state.loaded) {
    loadPage();
  }
});

window.V50_CORPUS_RELOAD = () => {
  state.page = 1;
  loadPage();
};
