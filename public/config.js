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
  },
  corpus: {
    pageSize: 20,
    submitTextMin: 1,
    submitTextMax: 1000,
    submitAuthorMax: 40,
    submitDefaultAuthor: '匿名',
    searchQueryMax: 60,
    toastTimeoutMs: 3200,
    statusLabels: {
      approved: '已收录',
      pending: '待审核'
    },
    messages: {
      submitSuccess: '投稿成功，等待审核',
      submitDuplicateApproved: '这条已经在语料库里了',
      submitDuplicatePending: '这条已在投稿队列中，等待审核',
      submitRateLimit: '今日投稿次数已达上限',
      submitTooShort: '不能为空',
      submitTooLong: '不能超过 1000 个字',
      submitGenericError: '投稿失败，请稍后再试',
      browseError: '加载失败，请稍后再试'
    }
  },
  admin: {
    tokenStorageKey: 'v50-admin-token',
    pageSize: 30,
    toastTimeoutMs: 2800,
    messages: {
      unauthorized: '验证失败，请检查 token',
      generic: '操作失败，请稍后再试',
      embedFailed: '索引失败，请稍后再试',
      approved: '已通过',
      deleted: '已删除'
    }
  }
};
