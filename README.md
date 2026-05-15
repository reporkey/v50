# V50 Copywriter

This repository is for a small Chinese "V50 copywriting generator" website.

The product idea is a playful tool for generating "Crazy Thursday / V50" style copy. Users can optionally enter keywords, choose a writing style, generate one short copy, regenerate another one, copy the result, and keep a short local history.

## Current Phase

The current phase is a static front-end prototype.

- No real backend yet.
- No real AI API calls yet.
- No API key input in the UI.
- Use local mock copy generation for now.
- Keep the code shaped so a future API-backed implementation can replace the mock generator.

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

## Future Architecture

The planned production architecture is:

- Frontend: Cloudflare Pages
- API: Cloudflare Worker, `POST /api/generate`
- Model: Cloudflare Workers AI
- Planned default model: `@cf/qwen/qwen3-30b-a3b-fp8`
- Planned domain: `v50.reporkey.com`

If the cloud model fails in the future version, the UI should show a short retry message such as:

```text
生成失败，请稍后再试
```

The future production version should not automatically pretend that a failed AI response succeeded.

## Design Direction

- The first screen should be the usable generator, not a marketing landing page.
- The visual mood can reference fast food, Crazy Thursday, and red/white energy.
- Do not use official KFC logos, official brand assets, or anything that looks like an official KFC page.
- The UI should feel like a polished, fun, practical mini tool.
- It must work well on desktop and mobile.
