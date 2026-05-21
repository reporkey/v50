// Frontend tuning knobs. Loaded as a classic <script> before app.js so
// it works under file:// (ESM imports are blocked from file:// origins).
// Mirror `input.keywordLimit` in functions/_lib/config.js — the backend's
// validation must match the HTML input attribute set from here.

window.V50_CONFIG = {
  input: {
    keywordLimit: 40
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
