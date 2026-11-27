# Bilingo 双语网页翻译

一个类似"沉浸式翻译"的浏览器扩展：在原文段落下方插入译文，双语对照阅读。面向 Chrome / Edge / Safari。

## 功能

- 整页双语对照翻译，只翻译**进入视口**的段落（省调用量），自动跟随动态加载的内容
- 自动跳过代码块、输入框、`notranslate` 区域，以及已经是目标语言的段落
- **只翻译正文**（默认，可关闭）：文章类网页（新闻、博客、文档）先用 Mozilla Readability（Firefox 阅读模式的算法）识别正文区域，只翻译标题和正文；其他网页按以下规则跳过导航、菜单、按钮、页眉页脚、标签胶囊、链接列表（如 "N points by X | N comments"），以及代码标识符、路径、版本号、@用户名等非自然语言文字；不翻译读屏专用的隐藏文字
- **不破坏布局**：插入译文前后测量附近容器，若译文会让固定尺寸的卡片、标签条等溢出，就撤回译文，改为虚线下划线提示、悬停显示译文
- 划词翻译（右键菜单）、可拖动的悬浮按钮、快捷键 `Alt+A`
- "总是翻译此网站"、5 种译文样式、浅色/深色模式
- 翻译结果持久化缓存（IndexedDB），同一段文字不会重复花钱

## 翻译服务

| 服务                      | 费用                             | 说明                                                                                                                                                                                                                                                                                                                                 |
| ------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **浏览器内置 AI**（默认） | 免费                             | Chrome 138+ / Edge 148+ 桌面版自带的本地模型（[Translator API](https://developer.chrome.com/docs/ai/translator-api)），不联网、文本不出本机。每个语言对首次使用需下载语言包                                                                                                                                                          |
| **本地大模型**            | 免费                             | 在本机显卡上用 WebGPU 运行开源翻译模型，离线可用：[Hy-MT2-1.8B](https://huggingface.co/tencent/Hy-MT2-1.8B)（推荐，约 1.1 GB，Apache-2.0）、[TranslateGemma 4B](https://huggingface.co/onnx-community/translategemma-text-4b-it-ONNX)（实验性，约 3.1 GB）或自定义模型。默认走 hf-mirror 镜像，支持断点续传；仅 Chrome / Edge 桌面版 |
| AI 大模型                 | 自带 Key 按量付费 / 部分平台免费 | 任意 OpenAI 兼容接口：DeepSeek、智谱、硅基流动、阿里百炼、OpenRouter、OpenAI、Ollama 本地模型等。设置页可"获取模型列表"                                                                                                                                                                                                              |
| Azure 翻译                | 每月 200 万字符免费              | 官方 API，需在 Azure 创建 F0 免费档 Translator 资源                                                                                                                                                                                                                                                                                  |
| DeepL                     | API Free 免费额度                | 官方 API                                                                                                                                                                                                                                                                                                                             |
| 谷歌翻译                  | 免费                             | 非官方接口，国内网络需代理                                                                                                                                                                                                                                                                                                           |

> 原先流行的微软 Edge 免费翻译接口（`edge.microsoft.com/translate/auth`）已于 2026 年 8 月前后失效，因此未接入。

## 开发

```bash
npm install
npm run dev          # 启动开发模式（自动打开 Chrome 并热更新）
npm test             # 单元测试（Vitest）
npm run test:e2e     # 构建后在真实 Chromium 中跑端到端测试（Playwright）
npm run check        # 类型检查
npm run lint         # ESLint（类型感知 + Svelte）
npm run format       # Prettier 格式化
```

### 构建 & 安装

```bash
npm run build        # → .output/chrome-mv3
npm run build:edge   # → .output/edge-mv3
npm run zip          # 打包上架用的 zip
```

Chrome：打开 `chrome://extensions` → 开启"开发者模式" → "加载已解压的扩展程序" → 选择 `.output/chrome-mv3`。
Edge：打开 `edge://extensions`，步骤相同，选择 `.output/edge-mv3`。

### Safari（需要 macOS + Xcode）

```bash
npm run build:safari                                   # → .output/safari-mv3
xcrun safari-web-extension-converter .output/safari-mv3 # 生成 Xcode 工程，在 Xcode 中运行
```

Safari 版后台使用非持久后台页而非 service worker（规避 WebKit 的 MV3 service worker 启动问题）。Safari 没有内置 Translator API，也没有 offscreen API，暂不支持本地大模型，请选用其他翻译服务。Safari 26 已支持 WebGPU，后续可让本地大模型在 Safari 的后台页中运行（尚未实现、未验证）。

## 架构

```
src/
├─ entrypoints/
│  ├─ background.ts        后台：翻译请求、右键菜单、快捷键
│  ├─ content/             内容脚本入口 + 译文样式
│  ├─ popup/               弹窗（Svelte 5）
│  └─ options/             设置页（Svelte 5）
├─ content/
│  ├─ segmenter.ts         段落识别（纯函数，有单元测试）
│  ├─ page-translator.ts   视口懒加载 → 语言检测 → 分批 → 插入译文；MutationObserver 处理动态内容
│  └─ page-ui.ts           悬浮按钮、划词气泡（Shadow DOM 隔离）
├─ background/
│  ├─ providers/           谷歌 / Azure / DeepL / OpenAI 兼容
│  ├─ translate.ts         缓存 + 并发控制 + 429/5xx 指数退避重试
│  └─ cache.ts             IndexedDB 持久缓存（LRU 修剪）
└─ shared/                 设置、语言表、类型化消息、内置 AI 封装
```

- 内置 AI 翻译在**内容脚本**中运行（该 API 不能在 service worker 中使用），其他服务都经由后台发请求。
- 本地大模型运行在 **offscreen 文档内的 Web Worker** 中（Transformers.js v4 + WebGPU）：service worker 空闲会被回收，不适合持有 1GB 模型；offscreen 文档常驻、所有标签页共享一份模型，空闲 10 分钟自动卸载释放显存。显卡支持 `shader-f16` 时用 q4f16，否则退回 q4。下载由 `src/local-llm/resumable-fetch.ts` 接管（`env.fetch`）：大文件按 16 MB 分块用 HTTP Range 下载，每块存入 Cache Storage，中断后从断点继续，连接 30 秒无数据自动重连。可选模型见 `src/local-llm/models.ts`：TranslateGemma 需要原文语言（后台用 `i18n.detectLanguage` 识别），并固定用 q4（Gemma 在 WebGPU 上用 fp16 会出乱码，onnxruntime#26732）。ONNX Runtime 的 wasm 随扩展打包在 `/ort/`（扩展禁止加载远程代码），CSP 为此开启 `'wasm-unsafe-eval'`。
- 大模型批量翻译使用带 id 的 JSON 协议（`{"segments":[{id,text}]}` → `{"translations":[{id,text}]}`），模型漏条时自动逐条补译；默认每批 1200 字符 / 6 段，以降低格式出错率。
- 译文一律以 `textContent` 插入，不会把模型输出当作 HTML 执行。

## 技术选型依据

- 框架 **WXT**：2026 年跨浏览器（含 Safari）扩展的主流选择；Plasmo 不支持 Safari，CRXJS 仅 Chromium。
- UI **Svelte 5**：WXT 官方支持，运行时最小。
- 样式 **原生现代 CSS**（`src/assets/ui.css`）：OKLCH 色彩 + `light-dark()` 自动明暗主题、可定制下拉框 `appearance: base-select`（Chrome/Edge 135+，其他浏览器自动降级为原生下拉框）、`@starting-style` 入场动画、`:has()`；图标用 **Lucide**（`@lucide/svelte`，按需引入）。没有用 Tailwind / shadcn-svelte：网页内的悬浮按钮和气泡在 Shadow DOM 里，工具类 CSS 不便注入；扩展页面只跑在新版浏览器上，原生 CSS 最轻。注意 Chromium 会给扩展页面注入 `body { font-size: 75% }`，`ui.css` 已覆盖。
- 消息 **@webext-core/messaging**：类型安全的扩展消息。
- 语言 **TypeScript 6.0**：TS 7（Go 原生编译器）暂不兼容 svelte-check，待其支持后升级。
- 检查 **ESLint 10 + typescript-eslint（类型感知）+ eslint-plugin-svelte**，格式化 **Prettier 3**：Biome / Oxlint 对 Svelte 的支持仍不完整。
- 本地模型 **Hy-MT2-1.8B**：与 HY-MT1.5 同句对比译文更准确，许可证为 Apache-2.0（HY-MT1.5 的许可证不适用于欧盟/英国/韩国）。
