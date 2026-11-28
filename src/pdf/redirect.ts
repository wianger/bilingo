// 在线 PDF 改用 Bilingo 阅读器打开（后台使用）。
// 做法与 Mozilla 官方的 pdf.js 扩展相同：declarativeNetRequest 按响应头（Content-Type 等）匹配 PDF，
// 重定向到扩展页面。响应头条件需要 Chrome / Edge 128+；不支持时不注册规则，用户仍可从悬浮球 / 弹窗手动打开。
// 参考：https://github.com/mozilla/pdf.js/blob/master/extensions/chromium/pdfHandler.js

type Rule = Browser.declarativeNetRequest.Rule;

/** 本扩展的动态规则只用于 PDF 跳转，id 固定在这个范围 */
const RULE_IDS = [1, 2, 3, 4, 5, 6];
/** "用浏览器自带查看器打开"时，为该标签页临时放行的会话规则 */
const NATIVE_RULE_BASE = 1000;

export const viewerUrl = () => browser.runtime.getURL('/pdf.html');

/** 阅读器地址：?file=<编码后的 PDF 地址>，PDF 地址里的 #page=2 之类片段放到阅读器的 hash */
export function viewerUrlFor(pdfUrl: string): string {
  const i = pdfUrl.indexOf('#');
  const hash = i > 0 ? pdfUrl.slice(i) : '';
  const file = i > 0 ? pdfUrl.slice(0, i) : pdfUrl;
  return `${viewerUrl()}?file=${encodeURIComponent(file)}${hash}`;
}

function buildRules(): Rule[] {
  const allow = { type: 'allow' } as const;
  // declarativeNetRequest 不能对匹配结果做编码，只能原样拼接；阅读器按 "?DNR:" 前缀解析
  const redirect = { type: 'redirect', redirect: { regexSubstitution: `${viewerUrl()}?DNR:\\0` } } as const;
  // 规则用普通对象书写（类型定义里的资源类型是枚举），最后统一转换
  const frames = ['main_frame', 'sub_frame'];
  const rules: Record<string, unknown>[] = [
    // 网页框架里明确要求下载的，不接管
    {
      condition: {
        urlFilter: '*',
        resourceTypes: ['sub_frame'],
        responseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
      action: allow,
    },
    // 地址带 =download 且要求下载的（如网盘的下载链接）
    {
      condition: {
        urlFilter: '=download',
        resourceTypes: ['main_frame'],
        responseHeaders: [{ header: 'content-disposition', values: ['attachment*'] }],
      },
      action: allow,
    },
    // 普通的 PDF（POST 请求的结果无法重新获取，不接管）
    {
      condition: {
        regexFilter: '^https?://.*$',
        excludedRequestMethods: ['post'],
        resourceTypes: frames,
        responseHeaders: [{ header: 'content-type', values: ['application/pdf', 'application/pdf;*'] }],
      },
      action: redirect,
    },
    // 类型写错（octet-stream）但地址是 .pdf
    {
      condition: {
        regexFilter: '^https?://.*\\.pdf\\b.*$',
        excludedRequestMethods: ['post'],
        resourceTypes: frames,
        responseHeaders: [
          { header: 'content-type', values: ['application/octet-stream', 'application/octet-stream;*'] },
        ],
      },
      action: redirect,
    },
    // 类型写错但 Content-Disposition 里的文件名是 .pdf（responseHeaders 之间是"或"，用排除条件模拟"且"）
    {
      condition: {
        regexFilter: '^https?://.*$',
        excludedRequestMethods: ['post'],
        resourceTypes: frames,
        responseHeaders: [{ header: 'content-disposition', values: ['*.pdf', '*.pdf"*', "*.pdf'*"] }],
        excludedResponseHeaders: [
          {
            header: 'content-type',
            excludedValues: ['application/octet-stream', 'application/octet-stream;*'],
          },
        ],
      },
      action: redirect,
    },
  ];
  // 排在前面的优先级高
  return rules.map((r, i) => ({ ...r, id: RULE_IDS[i]!, priority: rules.length - i + 1 }) as unknown as Rule);
}

/**
 * 浏览器是否真正支持响应头条件。Chrome 123–127 能识别该字段但会忽略它，
 * 那样注册的规则会把所有页面都重定向；检测方法见 https://github.com/w3c/webextensions/issues/638
 */
async function headerConditionSupported(): Promise<boolean> {
  const dnr = browser.declarativeNetRequest;
  const id = 999;
  const probe = (responseHeaders: unknown[]) =>
    dnr.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          condition: { responseHeaders, urlFilter: '|does_not_match_anything' },
          action: { type: 'block' },
        } as Rule,
      ],
    });
  try {
    await probe([{ header: 'whatever' }]);
  } catch {
    return false;
  }
  try {
    // 空数组应当校验失败；校验通过说明功能未启用
    await probe([]);
    return false;
  } catch {
    return true;
  } finally {
    await dnr.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }
}

/** 按设置注册 / 移除跳转规则（可重复调用） */
export async function syncPdfRedirect(enabled: boolean): Promise<void> {
  const dnr = browser.declarativeNetRequest;
  if (!dnr?.updateDynamicRules) return;
  const existing = (await dnr.getDynamicRules()).filter((r) => RULE_IDS.includes(r.id)).map((r) => r.id);
  const addRules = enabled && (await headerConditionSupported()) ? buildRules() : [];
  await dnr.updateDynamicRules({ removeRuleIds: existing, addRules });
}

/** 在当前标签页改用浏览器自带的查看器打开：先给这个标签页加一条放行规则，再跳转 */
export async function openNative(tabId: number, url: string): Promise<void> {
  const dnr = browser.declarativeNetRequest;
  const id = NATIVE_RULE_BASE + (tabId % 100000);
  await dnr
    ?.updateSessionRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: 100,
          condition: { tabIds: [tabId], resourceTypes: ['main_frame'] },
          action: { type: 'allow' },
        } as unknown as Rule,
      ],
    })
    .catch(() => {});
  // 页面加载完后撤销放行，之后在这个标签页打开的 PDF 仍然自动接管
  const done = (changedId: number, info: { status?: string }) => {
    if (changedId !== tabId || info.status !== 'complete') return;
    browser.tabs.onUpdated.removeListener(done);
    void dnr?.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  };
  browser.tabs.onUpdated.addListener(done);
  await browser.tabs.update(tabId, { url });
}
