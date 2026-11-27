import { describe, expect, it } from 'vitest';
import { buildPrompt, cleanOutput, maxNewTokens } from '@/local-llm/prompt';

describe('Hy-MT2 prompt', () => {
  it('uses the Chinese template with a Chinese language name for Chinese targets', () => {
    expect(buildPrompt('Hello', 'zh-CN')).toBe(
      '将以下文本翻译为中文，注意只需要输出翻译后的结果，不要额外解释：\n\nHello',
    );
    expect(buildPrompt('Hello', 'zh-TW')).toContain('翻译为繁体中文');
  });

  it('uses the English template with an English language name otherwise', () => {
    expect(buildPrompt('你好', 'ja')).toBe(
      'Translate the following text into Japanese. Note that you should only output the translated result without any additional explanation:\n\n你好',
    );
  });

  it('bounds generation length and strips think blocks', () => {
    expect(maxNewTokens('hi')).toBe(64);
    expect(maxNewTokens('x'.repeat(10_000))).toBe(2048);
    expect(cleanOutput('<think>…</think>\n 你好 ')).toBe('你好');
  });
});

describe('local model presets', () => {
  it('maps language codes to TranslateGemma codes', async () => {
    const { toTranslateGemmaCode } = await import('@/local-llm/models');
    expect(toTranslateGemmaCode('zh-CN')).toBe('zh');
    expect(toTranslateGemmaCode('zh-TW')).toBe('zh-TW');
    expect(toTranslateGemmaCode('en')).toBe('en');
    expect(toTranslateGemmaCode('pt_BR')).toBe('pt');
    expect(toTranslateGemmaCode('xx')).toBeNull();
  });

  it('builds structured TranslateGemma messages and plain Hy-MT prompts', async () => {
    const { buildMessages } = await import('@/local-llm/prompt');
    expect(buildMessages('translategemma', 'Hello', 'zh-CN', 'en')).toEqual([
      { role: 'user', content: [{ type: 'text', source_lang_code: 'en', target_lang_code: 'zh', text: 'Hello' }] },
    ]);
    // 识别不出原文语言时回退为英语，避免模板因未知代码报错
    const [m] = buildMessages('translategemma', 'Hello', 'ja', '');
    expect((m!.content as Record<string, string>[])[0]!.source_lang_code).toBe('en');
    const [h] = buildMessages('hymt', 'Hello', 'zh-CN');
    expect(h!.content).toContain('将以下文本翻译为中文');
  });

  it('treats unknown repos as custom Hy-MT-style models', async () => {
    const { formatOf, findPreset } = await import('@/local-llm/models');
    expect(formatOf('onnx-community/translategemma-text-4b-it-ONNX')).toBe('translategemma');
    expect(findPreset('onnx-community/translategemma-text-4b-it-ONNX')?.dtype).toBe('q4');
    expect(formatOf('someone/custom-model')).toBe('hymt');
  });
});
