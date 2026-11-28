import { m, setUiLang } from '@/shared/i18n';
import { PageTranslator, translateBatch } from '@/content/page-translator';
import { PageUI } from '@/content/page-ui';
import { onMessage } from '@/shared/messaging';
import { DEFAULT_SETTINGS, getSettings, saveSettings, watchSettings, type Settings } from '@/shared/settings';
import { ElementPicker, type PickAction } from '@/content/picker';
import './style.css';

declare global {
  interface Window {
    __bilingoLoaded?: boolean;
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    // 防止按需注入时重复初始化
    if (window.__bilingoLoaded) return;
    window.__bilingoLoaded = true;

    let settings: Settings = DEFAULT_SETTINGS;
    const translator = new PageTranslator(() => settings);
    const ui = new PageUI(() => translator.toggle());
    translator.onChange = (active) => ui.setBall(settings.floatBall, active);

    async function translateSelection() {
      const sel = getSelection();
      const text = sel?.toString().trim();
      if (!sel || !text || !sel.rangeCount) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      ui.showBubble(rect, m.translating(), 'loading');
      try {
        const [result] = await translateBatch([text], settings);
        ui.showBubble(rect, result || text);
      } catch (e) {
        ui.showBubble(rect, m.translate_failed({ msg: (e as Error).message }), 'error');
      }
    }

    // 布局放不下译文的段落：鼠标悬停时用气泡显示译文
    let hintEl: Element | null = null;
    document.addEventListener('pointerover', (e) => {
      const el = (e.target as Element | null)?.closest?.('[data-bilingo="hint"]') ?? null;
      if (el === hintEl) return;
      hintEl = el;
      const text = el && translator.hintOf(el);
      if (el && text) ui.showBubble(el.getBoundingClientRect(), text, 'ok', true);
      else ui.hideHint();
    });

    onMessage('toggle', () => ({ active: translator.toggle() }));
    onMessage('status', () => ({ active: translator.active }));
    onMessage('retranslate', () => {
      if (translator.active) {
        translator.restore();
        translator.start();
      }
      return { active: translator.active };
    });
    onMessage('translateSelection', () => {
      void translateSelection();
    });

    // 网页上点选区域 → 写入当前网站的用户规则 → 重新翻译
    const picker = new ElementPicker((action, selector) => void saveRule(action, selector));
    onMessage('startPicker', () => picker.start());

    async function saveRule(action: PickAction, selector: string) {
      const host = location.hostname.replace(/^www\./, '');
      const id = `site:${host}`;
      const rules = structuredClone(settings.siteRules);
      let rule = rules.find((r) => r.id === id);
      if (!rule) {
        rule = { id, matches: [host] };
        rules.push(rule);
      }
      const list = (rule[action] ??= []);
      if (!list.includes(selector)) list.push(selector);
      settings = await saveSettings({ siteRules: rules });
      if (translator.active) {
        translator.restore();
      }
      translator.start();
      const msg = action === 'exclude' ? m.picker_saved_exclude({ host }) : m.picker_saved_include({ host });
      ui.showBubble(new DOMRect(innerWidth / 2 - 150, 16, 300, 0), msg, 'ok', true);
      setTimeout(() => ui.hideHint(), 3500);
    }

    watchSettings((next) => {
      const prev = settings;
      settings = next;
      if (setUiLang(next.uiLang)) ui.applyLabels();
      if (prev.style !== next.style) translator.restyle(next.style);
      const rulesChanged =
        JSON.stringify([prev.siteRules, prev.disabledBuiltinRules]) !==
        JSON.stringify([next.siteRules, next.disabledBuiltinRules]);
      if ((prev.scope !== next.scope || rulesChanged) && translator.active) {
        translator.restore();
        translator.start();
      }
      ui.setBall(next.floatBall, translator.active);
    });

    settings = await getSettings();
    if (setUiLang(settings.uiLang)) ui.applyLabels();
    ui.setBall(settings.floatBall, translator.active);
    if (settings.autoSites.includes(location.hostname)) translator.start();
  },
});
