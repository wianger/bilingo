import { closeOffscreen, prepareLocal } from '@/background/providers/local';
import { listOpenAIModels } from '@/background/providers/openai';
import { cacheClear } from '@/background/cache';
import { translateTexts } from '@/background/translate';
import { onMessage } from '@/shared/messaging';
import { m, setUiLang } from '@/shared/i18n';
import { getSettings, watchSettings } from '@/shared/settings';
import { sendToTab } from '@/shared/tabs';

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

  // 界面语言（错误信息、右键菜单）跟随设置
  const ready = getSettings().then((s) => setUiLang(s.uiLang));
  watchSettings((s) => {
    if (setUiLang(s.uiLang)) void updateMenuTitles();
  });

  browser.runtime.onInstalled.addListener(() => void setupMenus());

  async function setupMenus() {
    await ready;
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({ id: 'bilingo-page', title: m.menu_page(), contexts: ['page'] });
    browser.contextMenus.create({ id: 'bilingo-selection', title: m.menu_selection(), contexts: ['selection'] });
  }

  async function updateMenuTitles() {
    await browser.contextMenus.update('bilingo-page', { title: m.menu_page() }).catch(() => {});
    await browser.contextMenus.update('bilingo-selection', { title: m.menu_selection() }).catch(() => {});
  }

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    sendToTab(tab.id, info.menuItemId === 'bilingo-selection' ? 'translateSelection' : 'toggle').catch(() => {});
  });

  browser.commands.onCommand.addListener((command) => {
    if (command !== 'toggle-translate') return;
    void browser.tabs
      .query({ active: true, currentWindow: true })
      .then(([tab]) => (tab?.id ? sendToTab(tab.id, 'toggle') : undefined))
      .catch(() => {});
  });
});
