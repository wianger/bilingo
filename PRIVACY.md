# Privacy Policy · 隐私政策

_Last updated: 2026-11-28_

## English

Bilingo has **no server** and collects **no analytics, telemetry or personal data**.

- **Settings and API keys** are stored only in your browser (`chrome.storage.local`). They are never sent anywhere except to the API endpoint you configured, as the authentication for your own requests.
- **Translation cache**: translated text is cached locally in your browser (IndexedDB) so the same paragraph is not translated twice. You can clear it in Settings → 其他 (Other) → 清空缓存 (Clear cache).
- **Page text** is sent only when you translate, and only to the engine you selected, directly from your browser:
  - **Browser built-in AI** and **local LLM**: text never leaves your device. The local LLM downloads model files from Hugging Face or the mirror you selected; no page text is sent.
  - **OpenAI-compatible API, Azure, DeepL, Google**: text is sent to that provider and is subject to its privacy policy.
- **Permissions**: `<all_urls>` and `scripting` are needed to translate any page you open and to call the API endpoint you configure; `storage` keeps your settings; `activeTab` lets the toolbar popup talk to the current tab; `contextMenus` adds the selection-translation menu; `offscreen` hosts the local model.

## 简体中文

Bilingo **没有服务器**，**不收集任何统计、遥测或个人数据**。

- **设置和 API Key** 只保存在你的浏览器中（`chrome.storage.local`），除了作为你自己请求的身份验证发给你配置的接口外，不会发往任何地方。
- **翻译缓存**：译文缓存在浏览器本地（IndexedDB），同一段文字不会重复翻译。可在 设置 → 其他 → 清空缓存 中清除。
- **网页文字**只在你翻译时、只发给你选择的引擎，并且由浏览器直接发送：
  - **浏览器内置 AI** 和 **本地大模型**：文字不会离开你的设备。本地大模型会从 Hugging Face 或你选择的镜像下载模型文件，不会发送网页文字。
  - **OpenAI 兼容接口、Azure、DeepL、谷歌**：文字会发给对应服务商，受其隐私政策约束。
- **权限说明**：`<all_urls>` 和 `scripting` 用于翻译你打开的任意网页、调用你配置的接口；`storage` 用于保存设置；`activeTab` 用于工具栏弹窗与当前标签页通信；`contextMenus` 用于划词翻译菜单；`offscreen` 用于运行本地模型。
