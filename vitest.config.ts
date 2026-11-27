import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';
import { paraglideVitePlugin } from '@inlang/paraglide-js';

export default defineConfig({
  plugins: [WxtVitest(), paraglideVitePlugin({ project: './project.inlang', outdir: './src/paraglide' })],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['fake-indexeddb/auto'],
  },
});
