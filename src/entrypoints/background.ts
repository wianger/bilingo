import { closeOffscreen, prepareLocal } from '@/background/providers/local';
import { listOpenAIModels } from '@/background/providers/openai';
import { cacheClear } from '@/background/cache';
import { translateTexts } from '@/background/translate';
import { onMessage } from '@/shared/messaging';
import { getSettings } from '@/shared/settings';
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

  browser.runtime.onInstalled.addListener(() => void setupMenus());

  async function setupMenus() {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({ id: 'bilingo-page', title: '翻译此页面 / 显示原文', contexts: ['page'] });
    browser.contextMenus.create({ id: 'bilingo-selection', title: '翻译“%s”', contexts: ['selection'] });
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
