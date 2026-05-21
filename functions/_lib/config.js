// Backend tuning knobs. Underscore-prefixed dir is non-routable in Pages.
// Mirror `input.keywordLimit` and the user-facing message strings in
// public/config.js, which the browser loads as a classic script.

export const CONFIG = {
  ai: {
    chatModel: '@cf/moonshotai/kimi-k2.5',
    embeddingModel: '@cf/baai/bge-m3',
    maxCompletionTokens: 520,
    defaultQuery: '周四 V我50',
    temperature: { initial: 0.9, regen: 0.95, deepSearch: 1 }
  },
  retrieval: {
    referenceLimit: 6,
    topK: { standard: 30, deepSearch: 50 },
    mmrLambda: { focused: 0.75, balanced: 0.55, diverse: 0.45 },
    attemptThresholds: { reuseMax: 2, deepSearch: 3, maxDiversity: 4 }
  },
  input: {
    keywordLimit: 40,
    copyTextLimit: 500,
    previousOutputsLimit: 5,
    previousOutputItemLimit: 360,
    usedReferenceIdsLimit: 80,
    usedReferenceIdItemLimit: 120,
    maxAttemptNo: 20
  },
  rateLimit: {
    minutely: 10,
    daily: 40,
    minuteBucketTtlSeconds: 90,
    dayBucketTtlSeconds: 90000
  }
};
