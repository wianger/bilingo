# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
