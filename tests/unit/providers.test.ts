import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { parseBatchOutput, translateOpenAI } from '@/background/providers/openai';
import { translateTexts } from '@/background/translate';
import { sameLanguage, toAzureCode, toBuiltinCode, toDeepLCode } from '@/shared/langs';
import { DEFAULT_SETTINGS, mergeSettings, saveSettings, type Settings } from '@/shared/settings';

const chatReply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

const openaiSettings = (): Settings =>
  mergeSettings(DEFAULT_SETTINGS, {
    provider: 'openai',
    openai: { apiKey: 'sk-test', baseUrl: 'https://llm.test/v1' },
  });

describe('parseBatchOutput', () => {
  it('parses the canonical object format', () => {
    const m = parseBatchOutput('{"translations":[{"id":1,"text":"你好"},{"id":2,"text":"世界"}]}');
    expect([...m.entries()]).toEqual([
      [1, '你好'],
      [2, '世界'],
    ]);
  });

  it('tolerates code fences, think blocks, chatter and bare arrays', () => {
    expect(parseBatchOutput('<think>hmm</think>```json\n["a","b"]\n```').get(2)).toBe('b');
    expect(parseBatchOutput('Sure! {"translations":[{"id":1,"text":"x"}]} done').get(1)).toBe('x');
    expect(parseBatchOutput('not json at all').size).toBe(0);
  });
});

describe('translateOpenAI', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends one batch request and maps results by id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(chatReply('{"translations":[{"id":2,"text":"乙"},{"id":1,"text":"甲"}]}'));
    expect(await translateOpenAI(['A', 'B'], openaiSettings())).toEqual(['甲', '乙']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://llm.test/v1/chat/completions');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(init!.body as string) as { messages: { content: string }[] };
    expect(body.messages[1]!.content).toContain('"segments"');
  });

  it('falls back to single requests for ids the model dropped', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(chatReply('{"translations":[{"id":1,"text":"甲"}]}'))
      .mockResolvedValueOnce(chatReply('乙'));
    expect(await translateOpenAI(['A', 'B'], openaiSettings())).toEqual(['甲', '乙']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('requires an API key for remote endpoints but not localhost', async () => {
    const s = openaiSettings();
    s.openai.apiKey = '';
    await expect(translateOpenAI(['A'], s)).rejects.toThrow('API key');
    s.openai.baseUrl = 'http://localhost:11434/v1';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatReply('甲'));
    expect(await translateOpenAI(['A'], s)).toEqual(['甲']);
  });
});

describe('translateTexts (cache + retry)', () => {
  beforeEach(() => fakeBrowser.reset());
  afterEach(() => vi.restoreAllMocks());

  it('serves repeated texts from the persistent cache', async () => {
    await saveSettings({ provider: 'openai', openai: { apiKey: 'k', baseUrl: 'https://llm.test/v1' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(chatReply('缓存测试'));
    expect(await translateTexts(['cache me please'])).toEqual(['缓存测试']);
    expect(await translateTexts(['cache me please'])).toEqual(['缓存测试']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 429', async () => {
    await saveSettings({ provider: 'openai', openai: { apiKey: 'k', baseUrl: 'https://llm.test/v1' } });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('slow down', { status: 429 }))
      .mockResolvedValueOnce(chatReply('重试成功'));
    expect(await translateTexts(['retry text unique'])).toEqual(['重试成功']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('does not retry on HTTP 401', async () => {
    await saveSettings({ provider: 'openai', openai: { apiKey: 'bad', baseUrl: 'https://llm.test/v1' } });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('invalid key', { status: 401 }));
    await expect(translateTexts(['auth fail text'])).rejects.toThrow('HTTP 401');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('language codes', () => {
  it('maps codes per provider', () => {
    expect(toBuiltinCode('zh-CN')).toBe('zh');
    expect(toAzureCode('zh-TW')).toBe('zh-Hant');
    expect(toDeepLCode('zh-CN')).toBe('ZH-HANS');
    expect(toDeepLCode('en')).toBe('EN-US');
  });

  it('compares languages by base code but keeps zh variants apart', () => {
    expect(sameLanguage('zh', 'zh-CN')).toBe(true);
    expect(sameLanguage('en-US', 'en')).toBe(true);
    expect(sameLanguage('zh-Hant', 'zh-CN')).toBe(false);
  });
});
