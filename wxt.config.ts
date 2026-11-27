import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'wxt';
import { fileURLToPath } from 'node:url';

// Transformers.js（WebGPU）使用的 ONNX Runtime wasm。扩展禁止加载远程代码，需随扩展打包。
const ORT_DIST = fileURLToPath(new URL('./node_modules/onnxruntime-web/dist/', import.meta.url));
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

const paraglide = () => paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide' });

// https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  vite: () => ({
    // 界面文字：messages/{locale}.json → src/paraglide（编译期生成、类型安全、按需打包）
    plugins: [paraglide()],
    // Worker（本地模型）单独打包，不继承上面的插件，需要再注册一次
    worker: { format: 'es', plugins: () => [paraglide()] },
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
    // 名称、描述按浏览器语言取自 public/_locales（manifest 只能用浏览器原生的 i18n）
    name: '__MSG_extName__',
    default_locale: 'en',
    homepage_url: 'https://github.com/wianger/bilingo',
    description: '__MSG_extDescription__',
    permissions: ['storage', 'contextMenus', 'scripting', 'activeTab', 'offscreen'],
    host_permissions: ['<all_urls>'],
    // 'wasm-unsafe-eval'：运行本地模型的 WebAssembly 所需（MV3 允许的唯一放宽项）
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    commands: {
      'toggle-translate': {
        suggested_key: { default: 'Alt+A' },
        description: '__MSG_cmdToggle__',
      },
    },
  },
});
