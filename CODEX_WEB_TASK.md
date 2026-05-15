# Codex Web Task: Static Frontend Prototype

Build the first static frontend prototype for this repository.

## Scope

Implement a pure frontend prototype only.

- Do not connect to a real backend.
- Do not call a real AI API.
- Do not add an API key input.
- Do not deploy anything.
- Do not create Cloudflare resources.
- Use local mock generation.

## Recommended Tech

Use the simplest static setup unless there is already a frontend framework in the repository.

This repository currently has no app scaffold, so prefer:

- `index.html`
- `styles.css`
- `app.js`

No build step is required for this prototype.

## Product Requirements

Create a single-page "V50 copywriting generator" website.

Visible text should be in Chinese.

Required UI:

- Title: `V我50 文案机`
- Optional keyword input.
- Style selector with these options:
  - `随机`
  - `发疯文学`
  - `打工人`
  - `深情`
  - `朋友圈`
  - `荒诞`
- Primary button: `生成文案`
- Secondary action: `再来一条`
- Copy button for the current result.
- Recent history area showing the latest 5 generated copies.
- A small prototype notice, for example: `当前为前端原型，暂未连接 AI。`

## Interaction Requirements

- Generate copy locally from mock templates.
- If the keyword input is non-empty, naturally include the keyword in the generated copy.
- If the keyword input is empty, generate a generic V50 / Crazy Thursday copy.
- `再来一条` should generate a fresh result with the same current inputs.
- Copy button should copy the current result and show a short `已复制` feedback.
- Save the latest 5 generated results in `localStorage`.
- Load saved history on page load.
- Keep a function boundary such as:

```js
async function generateCopy({ keywords, style }) {
  // For now, call mockGenerateCopy.
  // Future implementation can call Cloudflare Worker /api/generate here.
}
```

## Mock Copy Guidance

The mock generator should produce short Chinese V50-style copy, usually 30-100 Chinese characters.

It can be silly, dramatic, and internet-native, but should avoid:

- pretending to be an official KFC account
- asking for real money transfer details
- using official KFC logos or brand assets
- hateful, harassing, or explicit content

## Visual Direction

- Make it feel like a real usable mini tool, not a marketing landing page.
- First screen should contain the actual generator.
- Use fast-food / Crazy Thursday energy with red, white, warm yellow, and dark text accents.
- Do not use official KFC logo, official imagery, or trademark-like assets.
- Avoid making the page look like an official brand page.
- Make mobile layout polished and usable.
- Make desktop layout balanced, with clear result output and history.

## Acceptance Checklist

- Opening `index.html` directly in a browser works.
- Generating without keywords works.
- Generating with keywords works.
- Every style option can generate text.
- Copy button works.
- `localStorage` history persists across refresh.
- No backend/API calls are made.
- No API key appears anywhere.
- Layout works on mobile and desktop.
