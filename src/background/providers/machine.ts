// 传统机器翻译服务
import { m } from '@/shared/i18n';
import { toAzureCode, toDeepLCode } from '@/shared/langs';
import type { Settings } from '@/shared/settings';
import { request, TranslateError } from '../http';

/** 谷歌 gtx 免费接口（非官方，可能变动；国内网络需代理） */
export async function translateGoogle(texts: string[], s: Settings): Promise<string[]> {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=${encodeURIComponent(s.targetLang)}`;
  return Promise.all(
    texts.map(async (q) => {
      const res = await request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ q }),
        },
        m.prov_google_name(),
      );
      const data = (await res.json()) as [[string | null, ...unknown[]][] | null] | null;
      return (data?.[0] ?? []).map((seg) => seg?.[0] ?? '').join('');
    }),
  );
}

/** Azure AI Translator v3.0（官方接口，F0 免费档每月 200 万字符） */
export async function translateAzure(texts: string[], s: Settings): Promise<string[]> {
  if (!s.azure.key) throw new TranslateError(m.err_need_azure_key());
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': s.azure.key.trim(),
  };
  if (s.azure.region.trim()) h['Ocp-Apim-Subscription-Region'] = s.azure.region.trim();
  const res = await request(
    `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(toAzureCode(s.targetLang))}`,
    { method: 'POST', headers: h, body: JSON.stringify(texts.map((Text) => ({ Text }))) },
    m.prov_azure_name(),
  );
  const data = (await res.json()) as { translations?: { text: string }[] }[];
  return data.map((d) => d.translations?.[0]?.text ?? '');
}

/** DeepL API（Free 密钥以 :fx 结尾，走 api-free 域名） */
export async function translateDeepL(texts: string[], s: Settings): Promise<string[]> {
  const key = s.deepl.key.trim();
  if (!key) throw new TranslateError(m.err_need_deepl_key());
  const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const res = await request(
    `${host}/v2/translate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
      body: JSON.stringify({ text: texts, target_lang: toDeepLCode(s.targetLang) }),
    },
    'DeepL',
  );
  const data = (await res.json()) as { translations?: { text: string }[] };
  return (data.translations ?? []).map((t) => t.text);
}
