// ESLint 10 flat config：TypeScript（类型感知）+ Svelte 5
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import paraglide from '@inlang/paraglide-js/eslint';
import ts from 'typescript-eslint';

export default ts.config(
  {
    ignores: [
      '.output/',
      '.wxt/',
      'node_modules/',
      'test-results/',
      'playwright-report/',
      'src/paraglide/',
      '**/dist/',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions },
      parserOptions: {
        projectService: true,
        extraFileExtensions: ['.svelte'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // 消息函数必须静态调用（m.foo()），否则无法按需打包
    files: ['src/**/*.{ts,svelte}'],
    plugins: { paraglide },
    rules: { 'paraglide/no-dynamic-message-access': ['error', { messageModuleDirectories: ['paraglide'] }] },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: { parserOptions: { parser: ts.parser } },
  },
  {
    files: ['*.config.{js,ts}', 'scripts/**', 'tests/e2e/**', 'tests/webkit/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['scripts/**', 'eslint.config.js', 'tests/webkit/*.mjs'],
    ...ts.configs.disableTypeChecked,
  },
);
