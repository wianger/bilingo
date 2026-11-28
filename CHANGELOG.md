# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Download translated PDFs: the reader's download menu offers a translated PDF, a bilingual side-by-side PDF, or the original file. Pages are rendered at 150 DPI (like pdf.js printing) with the translation as real, selectable text; the browser's "Save as PDF" embeds the fonts, so every language works.
- Optional AI layout analysis for PDFs: PP-DocLayoutV3 (PaddleOCR 3.x, Apache-2.0; WebGPU-ready fp16 export, 66 MB, pinned revision and SHA-256 checked) runs on-device in a Worker on WebGPU, falling back to WebAssembly. Text lines are grouped by the detected regions in the model's reading order; formulas, tables, figures, headers, footers, page numbers and references stay untouched; lines outside any region still use the geometric rules.
- Bilingual subtitles on other video sites through HTML5 subtitle tracks (Vimeo, Plyr, `<track>` and other players that expose `video.textTracks`): a Bilingo button on the video toggles them; Bilingo follows the track selected in the player, hides the native captions and handles roll-up WebVTT captions. Verified on Vimeo. The YouTube and generic subtitles now share one translation engine and overlay.
- Local LLM on Safari: Safari has no offscreen API, so the model host page runs as a hidden iframe inside the background page. ONNX Runtime is now bundled for Safari too. A new macOS workflow converts and compiles the Safari extension with Xcode, probes real Safari's WebGPU, and runs the real model through the same iframe → Worker → WebGPU path in Playwright's WebKit.

### Fixed

- Provider errors no longer show the raw HTML of an error page (for example Google's HTTP 429 page); only the page title is kept.

- PDF translation that keeps the layout. A new PDF reader (pdf.js 6) shows a translated copy of each page next to the original: paragraphs are rebuilt from the text geometry and replaced in place with the translation in the sampled background and text colour, while figures, formulas and tables stay untouched. Side by side / translation only / original views, hover highlighting, zoom, page navigation, local files by drag and drop, password-protected PDFs. Online PDFs can open in the reader automatically (Settings → Open online PDFs in Bilingo, via `declarativeNetRequest` response-header rules like Mozilla's pdf.js extension), or from the floating button in the browser's own PDF viewer. Verified in Edge on real arXiv papers.
- YouTube bilingual subtitles: a Bilingo button in the player's control bar shows the translation under the original subtitles, including auto-generated captions and fullscreen. Captions are obtained by intercepting the player's own caption request (YouTube requires a proof-of-origin token that extensions can't generate), joined into sentences, and translated about a minute ahead of playback. Verified on real YouTube videos with manual and auto-generated captions.
- Site rules: per-site "translate only" / "don't translate" areas and custom CSS. Create them by clicking an area of the page (popup → Choose what to translate…, or the context menu); the generated selectors avoid hashed class names and `nth-child`, so they keep working on other pages of the same site. Edit, import and export rules in settings. Built-in rules are supported but none ship yet: the candidate YouTube rule turned out unnecessary on today's YouTube.
- English interface. The UI follows the browser language by default and can be switched in Settings → Interface language, taking effect immediately in the popup, settings page, in-page button and context menus. Built with Paraglide JS (compile-time, type-safe messages); the extension name and description are localized through `_locales`.

## [0.2.0] - 2026-11-28

First public version.

### Added

- Bilingual page translation with viewport-based lazy loading, dynamic content support and a persistent IndexedDB cache.
- Six engines: browser built-in Translator API, local LLM on WebGPU (Hy-MT2 1.8B, TranslateGemma 4B, custom models), any OpenAI-compatible API, Azure AI Translator, DeepL and Google.
- Resumable chunked model downloads with stall detection.
- "Main content only" mode: Readability-based article detection plus rules that skip navigation, buttons, tag pills, link lists, code identifiers and screen-reader-only text.
- Layout guard: translations that would overflow fixed-size containers become hover hints.
- Draggable floating button (the Bilingo logo), selection translation, Alt+A shortcut, per-site auto translation, 5 translation styles, light and dark themes.
- Chrome, Edge and Safari (MV3) builds.
