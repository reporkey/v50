# V50 Copywriter

This repository is for a small Chinese "V50 copywriting generator" website.

The product idea is a playful tool for generating "Crazy Thursday / V50" style copy. Users can optionally enter keywords, choose a writing style, generate one short copy, regenerate another one, copy the result, and keep a short local history.

## Current Phase

The current phase is a Cloudflare Pages MVP.

- Frontend static files live in `public/`.
- `POST /api/generate` is implemented as a Cloudflare Pages Function.
- The backend calls Cloudflare Workers AI through the `AI` binding.
- Users do not enter API keys.
- A mock generator is still available when opening `public/index.html` directly or adding `?mock=1`.

## Planned Product Behavior

- Optional keyword input.
- Style selector:
  - Random
  - Crazy / absurd internet writing
  - Worker / office-worker tone
  - Romantic / dramatic tone
  - Moments / social-post tone
  - Absurd / surreal tone
- Generate one copy at a time.
- "Again" action to generate another copy.
- Copy-to-clipboard action.
- Recent history: store the latest 5 generated copies in `localStorage`.

## Architecture

- Frontend: Cloudflare Pages
- API: Cloudflare Pages Function, `POST /api/generate`
- Model: Cloudflare Workers AI, `@cf/qwen/qwen3-30b-a3b-fp8`
- Rate limiting: Cloudflare KV binding `RATE_LIMIT`
- Planned domain: `v50.reporkey.com`

If the cloud model fails, the UI shows:

```text
生成失败，请稍后再试
```

The production version should not automatically pretend that a failed AI response succeeded.

## Local Development

Install dependencies and run the Pages dev server:

```bash
npm install
npm run dev
```

Run syntax checks:

```bash
npm run check
```

Before production deployment, replace the placeholder KV IDs in `wrangler.toml` with the real `RATE_LIMIT` namespace IDs from Cloudflare.

## Design Direction

- The first screen should be the usable generator, not a marketing landing page.
- The visual mood can reference fast food, Crazy Thursday, and red/white energy.
- Do not use official KFC logos, official brand assets, or anything that looks like an official KFC page.
- The UI should feel like a polished, fun, practical mini tool.
- It must work well on desktop and mobile.
