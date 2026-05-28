const SUBMIT_CONFIG = window.V50_CONFIG.corpus;

const submitForm = document.getElementById('submitForm');
const textEl = document.getElementById('submitText');
const authorEl = document.getElementById('submitAuthor');
const submitBtn = document.getElementById('submitBtn');
const counterEl = document.getElementById('submitCounter');
const toastHost = document.getElementById('toastHost');

let submitting = false;

function updateState() {
  const length = textEl.value.trim().length;
  counterEl.textContent = String(length);
  const tooShort = length < SUBMIT_CONFIG.submitTextMin;
  const tooLong = length > SUBMIT_CONFIG.submitTextMax;
  submitBtn.disabled = submitting || tooShort || tooLong;
  const counterWrap = counterEl.parentElement;
  if (counterWrap) {
    counterWrap.classList.toggle('out-of-range', length > 0 && (tooShort || tooLong));
    counterWrap.dataset.hint = tooShort && length > 0 ? `至少 ${SUBMIT_CONFIG.submitTextMin} 字` : '';
  }
}

function showToast(message, kind) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${kind || 'info'}`;
  toast.textContent = message;
  toastHost.append(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, SUBMIT_CONFIG.toastTimeoutMs);
}

async function handleSubmit(event) {
  event.preventDefault();
  if (submitting) return;
  const text = textEl.value.trim();
  const author = authorEl.value.trim();

  submitting = true;
  updateState();
  submitBtn.classList.add('is-loading');
  const originalLabel = submitBtn.textContent;
  submitBtn.textContent = '提交中...';

  try {
    const response = await fetch('/api/corpus/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, author })
    });
    let payload = null;
    try { payload = await response.json(); } catch {}

    if (response.status === 201 && payload?.ok) {
      showToast(SUBMIT_CONFIG.messages.submitSuccess, 'success');
      textEl.value = '';
      authorEl.value = '';
      if (typeof window.V50_CORPUS_RELOAD === 'function') {
        window.V50_CORPUS_RELOAD();
      }
    } else if (response.status === 409 && payload?.error === 'duplicate') {
      const message =
        payload.existing_status === 'pending'
          ? SUBMIT_CONFIG.messages.submitDuplicatePending
          : SUBMIT_CONFIG.messages.submitDuplicateApproved;
      showToast(message, 'error');
    } else if (response.status === 429) {
      showToast(SUBMIT_CONFIG.messages.submitRateLimit, 'error');
    } else if (payload?.error === 'text_length') {
      const length = text.length;
      const message =
        length < SUBMIT_CONFIG.submitTextMin
          ? SUBMIT_CONFIG.messages.submitTooShort
          : SUBMIT_CONFIG.messages.submitTooLong;
      showToast(message, 'error');
    } else {
      showToast(SUBMIT_CONFIG.messages.submitGenericError, 'error');
    }
  } catch (error) {
    console.error(error);
    showToast(SUBMIT_CONFIG.messages.submitGenericError, 'error');
  } finally {
    submitting = false;
    submitBtn.classList.remove('is-loading');
    submitBtn.textContent = originalLabel;
    updateState();
  }
}

submitForm.addEventListener('submit', handleSubmit);
textEl.addEventListener('input', updateState);
authorEl.addEventListener('input', updateState);

updateState();
