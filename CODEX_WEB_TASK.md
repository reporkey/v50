# Codex Web Task: Cloudflare AI MVP

This repository has moved past the static prototype phase. Preserve the current Cloudflare Pages MVP shape.

## Current Architecture

- Static frontend files live in `public/`.
- The API route is `functions/api/generate.js`.
- `POST /api/generate` calls Cloudflare Workers AI through the `AI` binding.
- Rate limiting uses the Cloudflare KV binding `RATE_LIMIT`.
- Users should not enter API keys anywhere in the UI.
- The local mock generator remains only for direct `file://` preview or `?mock=1`.

## Product Behavior

- Users can optionally enter keywords, choose a style, generate one copy, generate another one, copy the latest successful result, and keep the latest 5 successful results in `localStorage`.
- API failures should show a short retry message and should not write to history.
- Rate-limit failures should show `请求太频繁，请稍后再试`.
- Do not use official KFC logos, official brand assets, or official-account language.

## Development Commands

```bash
npm install
npm run dev
npm run check
```

Before deploying, replace the placeholder `RATE_LIMIT` KV namespace IDs in `wrangler.toml`.

## Acceptance Checklist

- `npm run check` passes.
- `npm run dev` serves the frontend and Pages Function locally.
- `POST /api/generate` returns `{ ok: true, text, style, source: "ai" }` on success.
- Invalid style returns `400`.
- Rate limit returns `429`.
- `?mock=1` works without consuming AI usage.
