# Contributing to Bilingo

Thanks for helping! Issues and pull requests are welcome in English or Chinese. 欢迎用中文或英文提交 Issue 和 PR。

## Reporting problems

- **A page translates badly** (UI text translated, content skipped, layout broken): open a [site issue](https://github.com/wianger/bilingo/issues/new?template=site_issue.yml) with the URL, a screenshot, and whether "只翻译正文" (main content only) was on. These reports are the most valuable input for improving the segmentation rules.
- **Bugs**: use the [bug report](https://github.com/wianger/bilingo/issues/new?template=bug_report.yml) template.

## Development setup

Requirements: Node.js 22+ and Chrome or Edge.

```bash
npm install
npm run dev        # opens Chrome with the extension and hot reload
```

Before opening a pull request, run:

```bash
npm run lint && npm run check && npm run format:check && npm test && npm run test:e2e
```

CI runs the same checks. The e2e tests need Playwright's Chromium (`npx playwright install chromium`).

## Site rules

Users create site rules by clicking areas of a page. If a popular site needs a fix for everyone, it can become a built-in rule in `src/shared/site-rules.ts`:

- Add it only after checking it on the live site, with and without the rule, and describe the before/after in the pull request.
- Prefer stable selectors (`data-testid`, `itemprop`, semantic ids and classes); avoid generated class names and `nth-child`.
- Add the rule's description to `builtinRuleNote` in `src/ui/labels.ts` and to `messages/*.json`.

## Translating the interface

Interface text lives in `messages/{locale}.json` and is compiled by [Paraglide JS](https://github.com/opral/paraglide-js) into type-safe functions (`m.key()`).

- **Fix a translation**: edit the string in `messages/en.json` or `messages/zh-CN.json`.
- **Add text**: add the same key to every file in `messages/`. Keep `{placeholders}` identical. A unit test fails if keys or placeholders differ.
- **Add a language**: add it to `locales` in `project.inlang/settings.json`, create `messages/<locale>.json`, add an option in the settings page's language selector, and update `resolveLocale` in `src/shared/i18n.ts`. For the extension name in the browser's extension list, add `public/_locales/<locale>/messages.json`.
- Never edit `src/paraglide/`; it is generated.

## Code guidelines

- TypeScript strict mode, Svelte 5 runes, Prettier formatting (`npm run format`).
- Never insert translated text as HTML; always use `textContent`.
- Page-segmentation changes (`src/content/segmenter.ts`, `main-content.ts`) need a unit test, and ideally a check on a few real sites.
- No hard-coded interface text: use `m.*()` from `@/shared/i18n`.
- Code comments may be in Chinese or English.
- Keep dependencies minimal; the content script is injected into every page you translate.

## Technical notes

Decisions that are easy to get wrong:

- **Framework**: WXT is the only mainstream extension framework that targets Safari as well (Plasmo doesn't support Safari; CRXJS is Chromium-only).
- **TypeScript 6, not 7**: TS 7 (native Go compiler) isn't supported by `svelte-check` yet.
- **ESLint + Prettier, not Biome / Oxlint**: their Svelte support is incomplete.
- **Built-in Translator API** only works in window contexts, so it runs in the content script, not in the service worker.
- **Local LLM** lives in an offscreen document because service workers are suspended when idle and can't hold a 1 GB model. ONNX Runtime's `.wasm` is bundled under `/ort/` (no remote code in MV3), which needs `'wasm-unsafe-eval'` in the extension CSP.
- **Gemma models** must use `q4`, not `q4f16`: fp16 on WebGPU produces garbage output (onnxruntime#26732).
- **Chromium injects `body { font-size: 75% }`** into extension pages; `src/assets/ui.css` resets it.
- **Microsoft Edge's free translate endpoint** (`edge.microsoft.com/translate/auth`) stopped working around August 2026; don't add it back.
- **YouTube captions** require a proof-of-origin token (`pot`) since 2025; fetching `/api/timedtext` without it returns an empty 200. `youtube-main.content.ts` runs in the page's main world at `document_start`, captures the player's own request and hands the URL to the isolated content script. Headless browsers don't get a valid token, so real-site checks need a headed browser; CI uses a local fake YouTube.
- **Assets**: `assets/logo.svg` is the single source for the logo. Run `npm run icons` after editing it, and `npm run build && npm run screenshots` to refresh README images.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
