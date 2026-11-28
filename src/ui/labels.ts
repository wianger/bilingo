// 界面上展示的名称与说明：数据模块（settings、models）只存 id，文字在这里按界面语言取
import { m } from '@/shared/i18n';
import type { LocalModelPreset } from '@/local-llm/models';
import type { ProviderId, TranslationStyle } from '@/shared/settings';

export interface Tag {
  text: string;
  /** 免费类标签用绿色显示 */
  free?: boolean;
}

export function providerName(id: ProviderId): string {
  switch (id) {
    case 'builtin':
      return m.prov_builtin_name();
    case 'local':
      return m.prov_local_name();
    case 'google':
      return m.prov_google_name();
    case 'azure':
      return m.prov_azure_name();
    case 'deepl':
      return m.prov_deepl_name();
    case 'openai':
      return m.prov_openai_name();
  }
}

export function providerDesc(id: ProviderId): string {
  switch (id) {
    case 'builtin':
      return m.prov_builtin_desc();
    case 'local':
      return m.prov_local_desc();
    case 'google':
      return m.prov_google_desc();
    case 'azure':
      return m.prov_azure_desc();
    case 'deepl':
      return m.prov_deepl_desc();
    case 'openai':
      return m.prov_openai_desc();
  }
}

export function providerTags(id: ProviderId): Tag[] {
  const free = { text: m.tag_free(), free: true };
  switch (id) {
    case 'builtin':
      return [free, { text: m.tag_on_device() }];
    case 'local':
      return [free, { text: m.tag_offline() }, { text: m.tag_needs_gpu() }];
    case 'google':
      return [free];
    case 'azure':
      return [{ text: m.tag_azure_quota() }];
    case 'deepl':
      return [{ text: m.tag_deepl_quota() }];
    case 'openai':
      return [{ text: m.tag_openai_compatible() }];
  }
}

export function styleName(id: TranslationStyle): string {
  switch (id) {
    case 'faded':
      return m.style_faded();
    case 'plain':
      return m.style_plain();
    case 'underline':
      return m.style_underline();
    case 'highlight':
      return m.style_highlight();
    case 'quote':
      return m.style_quote();
  }
}

/** 内置网站规则的说明（新增内置规则时在这里加对应的界面文字） */
export function builtinRuleNote(_id: string): string | undefined {
  return undefined;
}

export function modelName(p: LocalModelPreset): string {
  return p.format === 'hymt' ? m.model_hymt_name() : p.name;
}

export function modelDesc(p: LocalModelPreset): string {
  return p.format === 'hymt' ? m.model_hymt_desc() : m.model_tg_desc();
}

export function modelLicense(p: LocalModelPreset): string {
  return p.format === 'translategemma' ? m.model_tg_license() : p.license;
}
