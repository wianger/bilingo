// WebKit 测试页：把本地大模型的托管代码（iframe → Worker → Transformers.js + WebGPU）单独打包成普通网页，
// 在 macOS 上用 Playwright 的 WebKit / 真实 Safari 运行（扩展本身无法在 CI 的 Safari 里加载）。
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import { defineConfig, defaultClientConditions } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Worker 从 /ort/ 加载 ONNX Runtime 的 wasm（与扩展相同），一并输出
const ORT = fileURLToPath(new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url));
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

const root = fileURLToPath(new URL('.', import.meta.url));
const paraglide = () =>
  paraglideVitePlugin({
    project: fileURLToPath(new URL('../../project.inlang', import.meta.url)),
    outdir: fileURLToPath(new URL('../../src/paraglide', import.meta.url)),
  });

export default defineConfig({
  root,
  resolve: {
    alias: { '@': fileURLToPath(new URL('../../src', import.meta.url)) },
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  worker: { format: 'es', plugins: () => [paraglide()] },
  plugins: [
    paraglide(),
    {
      name: 'bilingo-ort',
      generateBundle() {
        for (const f of ORT_FILES)
          this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(ORT + f) });
      },
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { index: `${root}index.html`, llm: `${root}llm.html` } },
  },
});
