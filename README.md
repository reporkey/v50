# V50 Copywriter

This repository is for a small Chinese "V50 copywriting generator" website.

The product idea is a playful tool for generating "Crazy Thursday / V50" style copy. Users can optionally enter keywords, generate one short copy, regenerate another one, copy the result, and keep a short local history.

## Current Phase

The current phase is a Cloudflare Pages MVP.

- Frontend static files live in `public/`.
- `POST /api/generate` is implemented as a Cloudflare Pages Function.
- The backend retrieves reference V50 examples from D1 + Vectorize, then calls Cloudflare Workers AI through the `AI` binding.
- Copied outputs are saved to D1 only after the user clicks Copy.
- Users do not enter API keys.
- A mock generator is still available when opening `public/index.html` directly or adding `?mock=1`.

## Planned Product Behavior

- Optional keyword input.
- Generate one copy at a time.
- "Again" action to generate another copy.
- Copy-to-clipboard action.
- Recent history: store the latest 5 generated copies in `localStorage`.

## Architecture

- Frontend: Cloudflare Pages
- API: Cloudflare Pages Functions, `POST /api/generate` and `POST /api/copy`
- Corpus store: Cloudflare D1 binding `DB`
- Vector index: Cloudflare Vectorize binding `V50_INDEX`
- Generation model: Cloudflare Workers AI, `@cf/qwen/qwen3-30b-a3b-fp8`
- Embedding model: Cloudflare Workers AI, `@cf/baai/bge-m3`
- Rate limiting: Cloudflare KV binding `RATE_LIMIT`
- Planned domain: `v50.reporkey.com`

If the cloud model fails, the UI shows:

```text
生成失败，请稍后再试
```

The production version should not automatically pretend that a failed AI response succeeded.

## Local Development

Install dependencies:

```bash
npm install
```

Create Cloudflare resources before using the real RAG path or running the Pages dev server:

```bash
npx wrangler d1 create v50-db
npx wrangler vectorize create v50-corpus --dimensions 1024 --metric cosine
```

Replace the placeholder D1 `database_id` in `wrangler.toml`, then run:

```bash
npm run migrate:local
npm run import:corpus
CLOUDFLARE_ACCOUNT_ID=<your-account-id> CLOUDFLARE_API_TOKEN=<your-api-token> npm run index:corpus
```

Then run the Pages dev server:

```bash
npm run dev
```

For production data:

```bash
npm run migrate:remote
npm run import:corpus -- --remote
CLOUDFLARE_ACCOUNT_ID=<your-account-id> CLOUDFLARE_API_TOKEN=<your-api-token> npm run index:corpus
```

Run syntax checks:

```bash
npm run check
```

Before production deployment, replace the placeholder D1 ID and confirm the KV IDs in `wrangler.toml`.

## Design Direction

- The first screen should be the usable generator, not a marketing landing page.
- The visual mood can reference fast food, Crazy Thursday, and red/white energy.
- Do not use official KFC logos, official brand assets, or anything that looks like an official KFC page.
- The UI should feel like a polished, fun, practical mini tool.
- It must work well on desktop and mobile.
