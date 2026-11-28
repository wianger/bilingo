import { sendMessage } from './messaging';

type TabMessage = 'toggle' | 'status' | 'retranslate' | 'translateSelection' | 'startPicker';
type TabReply<T extends TabMessage> = T extends 'translateSelection' | 'startPicker' ? void : { active: boolean };

async function inject(tabId: number) {
  await browser.scripting.insertCSS({ target: { tabId }, files: ['/content-scripts/content.css'] });
  await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
}

/** 向标签页发消息；若内容脚本尚未注入（安装扩展前就打开的页面），先注入再发 */
export async function sendToTab<T extends TabMessage>(tabId: number, type: T): Promise<TabReply<T>> {
  // 这些消息都不带参数；收窄到其中一个字面量即可匹配 sendMessage 的重载
  const send = (): Promise<unknown> => sendMessage(type as 'status', undefined, tabId);
  try {
    return (await send()) as TabReply<T>;
  } catch {
    await inject(tabId);
    return send() as Promise<TabReply<T>>;
  }
}
