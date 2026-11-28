import { closeOffscreen, prepareLocal } from '@/background/providers/local';
import { listOpenAIModels } from '@/background/providers/openai';
import { cacheClear } from '@/background/cache';
import { translateTexts } from '@/background/translate';
import { onMessage } from '@/shared/messaging';
import { m, setUiLang } from '@/shared/i18n';
import { getSettings, watchSettings } from '@/shared/settings';
import { sendToTab } from '@/shared/tabs';
import { openNative, syncPdfRedirect, viewerUrlFor } from '@/pdf/redirect';

export default defineBackground(() => {
  onMessage('translate', ({ data }) => translateTexts(data.texts, data.override));
  onMessage('listModels', ({ data }) => listOpenAIModels(data.baseUrl, data.apiKey));
  onMessage('clearCache', () => cacheClear());
  // 只触发加载、不等待完成：下载 1GB 模型可能超过 service worker 单次事件的时限，进度通过 llmStatusChanged 广播
  onMessage('localPrepare', async () => {
    void prepareLocal(await getSettings()).catch(() => {});
  });
  onMessage('localUnload', () => closeOffscreen());
  onMessage('llmIdle', () => closeOffscreen());
  // 发消息的标签页（内容脚本或阅读器页面所在的标签页）
  const tabOf = (sender: unknown) => (sender as { tab?: { id?: number } }).tab?.id;
  onMessage('openPdfViewer', async ({ data, sender }) => {
    const tabId = tabOf(sender);
    if (tabId !== undefined) await browser.tabs.update(tabId, { url: viewerUrlFor(data.url) });
  });
  onMessage('openPdfNative', async ({ data, sender }) => {
    const tabId = tabOf(sender);
    if (tabId !== undefined) await openNative(tabId, data.url);
  });

  // 界面语言（错误信息、右键菜单）跟随设置
  const ready = getSettings().then((s) => {
    setUiLang(s.uiLang);
    pdfAuto = s.pdf.autoOpen;
    void syncPdfRedirect(pdfAuto).catch(() => {});
  });
  let pdfAuto = false;
  watchSettings((s) => {
    if (setUiLang(s.uiLang)) void updateMenuTitles();
    if (s.pdf.autoOpen !== pdfAuto) {
      pdfAuto = s.pdf.autoOpen;
      void syncPdfRedirect(pdfAuto).catch(() => {});
    }
  });

  browser.runtime.onInstalled.addListener(() => void setupMenus());

  async function setupMenus() {
    await ready;
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({ id: 'bilingo-page', title: m.menu_page(), contexts: ['page'] });
    browser.contextMenus.create({ id: 'bilingo-selection', title: m.menu_selection(), contexts: ['selection'] });
    browser.contextMenus.create({ id: 'bilingo-pick', title: m.menu_pick(), contexts: ['page'] });
  }

  async function updateMenuTitles() {
    await browser.contextMenus.update('bilingo-page', { title: m.menu_page() }).catch(() => {});
    await browser.contextMenus.update('bilingo-selection', { title: m.menu_selection() }).catch(() => {});
    await browser.contextMenus.update('bilingo-pick', { title: m.menu_pick() }).catch(() => {});
  }

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    const action =
      info.menuItemId === 'bilingo-selection'
        ? 'translateSelection'
        : info.menuItemId === 'bilingo-pick'
          ? 'startPicker'
          : 'toggle';
    sendToTab(tab.id, action).catch(() => {});
  });

  browser.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-translate') return;
    void browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => (tab?.id ? sendToTab(tab.id, 'toggle') : undefined))
      .catch(() => {});
  });
});
