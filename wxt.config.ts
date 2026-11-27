import { defaultClientConditions } from 'vite';
import { defineConfig } from 'wxt';
import { fileURLToPath } from 'node:url';

// Transformers.js（WebGPU）使用的 ONNX Runtime wasm。扩展禁止加载远程代码，需随扩展打包。
const ORT_DIST = fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/', import.meta.url));
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  vite: () => ({
    worker: { format: 'es' },
    // 使用不内嵌 wasm 的 onnxruntime 构建，wasm 只从 /ort/ 加载一份
    resolve: { conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions] },
  }),
  hooks: {
    'build:publicAssets'(wxt, files) {
      if (wxt.config.browser === 'safari') return; // Safari 暂不支持本地大模型
      for (const f of ORT_FILES) files.push({ absoluteSrc: ORT_DIST + f, relativeDest: `ort/${f}` });
    },
    'build:manifestGenerated'(wxt, manifest) {
      if (wxt.config.browser !== 'safari') return;
      // Safari 的 MV3 service worker 存在启动问题（WebKit bug 270750），Safari 版改用非持久后台页
      if (manifest.background && 'service_worker' in manifest.background) {
        manifest.background = { scripts: [manifest.background.service_worker] };
      }
      // Safari 没有 offscreen API
      manifest.permissions = manifest.permissions?.filter((p) => p !== 'offscreen');
    },
  },
  manifest: {
    name: 'Bilingo 双语网页翻译',
    description:
      '双语对照网页翻译：原文下方显示译文。支持浏览器内置 AI、本地大模型、谷歌、Azure、DeepL 和任意 OpenAI 兼容的大模型接口。',
    permissions: ['storage', 'contextMenus', 'scripting', 'activeTab', 'offscreen'],
    host_permissions: ['<all_urls>'],
    // 'wasm-unsafe-eval'：运行本地模型的 WebAssembly 所需（MV3 允许的唯一放宽项）
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    commands: {
      'toggle-translate': {
        suggested_key: { default: 'Alt+A' },
        description: '翻译当前页面 / 显示原文',
      },
    },
  },
});
