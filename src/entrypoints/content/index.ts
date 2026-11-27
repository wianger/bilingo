import { PageTranslator, translateBatch } from '@/content/page-translator';
import { PageUI } from '@/content/page-ui';
import { onMessage } from '@/shared/messaging';
import { DEFAULT_SETTINGS, getSettings, watchSettings, type Settings } from '@/shared/settings';
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
      ui.showBubble(rect, '翻译中…', 'loading');
      try {
        const [result] = await translateBatch([text], settings);
        ui.showBubble(rect, result || text);
      } catch (e) {
        ui.showBubble(rect, `翻译失败：${(e as Error).message}`, 'error');
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

    watchSettings((next) => {
      const prev = settings;
      settings = next;
      if (prev.style !== next.style) translator.restyle(next.style);
      if (prev.scope !== next.scope && translator.active) {
        translator.restore();
        translator.start();
      }
      ui.setBall(next.floatBall, translator.active);
    });

    settings = await getSettings();
    ui.setBall(settings.floatBall, translator.active);
    if (settings.autoSites.includes(location.hostname)) translator.start();
  },
});
