// Frontend tuning knobs. Loaded as a classic <script> before app.js so
// it works under file:// (ESM imports are blocked from file:// origins).
// Keep `input.keywordLimit` and `input.previousOutputsLimit` in sync with
// functions/_lib/config.js — the backend clamps requests to the same values.

window.V50_CONFIG = {
  input: {
    keywordLimit: 40,
    previousOutputsLimit: 5,
    maxTrackedReferenceIds: 60
  },
  ui: {
    maxHistory: 5,
    copyFeedbackTimeoutMs: 1400,
    messages: {
      apiError: '生成失败，请稍后再试',
      rateLimit: '请求太频繁，请稍后再试',
      quotaExhausted: '今日生成量已用尽，请明天再试'
    }
  }
};
