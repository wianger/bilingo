// 运行在 YouTube 页面自身的 JS 环境（MAIN world），页面开始加载时注入。
// YouTube 的字幕接口要求请求带上播放器生成的"来源证明令牌"（pot 参数），扩展自己无法生成；
// 所以拦截播放器自己发出的字幕请求，把带令牌的网址交给内容脚本（隔离环境）重新获取 json3 格式。
// 同时响应内容脚本的请求：在字幕关闭时通过播放器接口打开字幕，触发播放器去请求。
// 只用 window.postMessage 通信，不接触扩展 API。

const SOURCE = 'bilingo-yt';

interface YtPlayer extends HTMLElement {
  getOption?: (module: string, option: string) => unknown;
  toggleSubtitles?: () => void;
  loadModule?: (name: string) => void;
}

export default defineContentScript({
  matches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    // 播放器通常在页面加载时就请求字幕，早于内容脚本开始监听；所以按视频缓存最近的网址，内容脚本询问时重发
    const latest = new Map<string, string>();
    const post = (url: string) => window.postMessage({ source: SOURCE, type: 'timedtext', url }, location.origin);
    const report = (url: string) => {
      if (!url.includes('/api/timedtext')) return;
      const abs = new URL(url, location.href);
      const v = abs.searchParams.get('v');
      if (!v || !abs.searchParams.get('pot')) return;
      latest.set(v, abs.href);
      post(abs.href);
    };

    // 保存原始方法，包装后原样调用（这里有意脱离对象引用，再用 Reflect.apply 绑定 this）
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: [string, string | URL]) {
      report(String(args[1]));
      Reflect.apply(open, this, args);
    };

    // eslint-disable-next-line @typescript-eslint/unbound-method -- 以 window 为 this 调用
    const fetchFn = window.fetch;
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      report(input instanceof Request ? input.url : String(input));
      return fetchFn.call(window, input, init);
    };

    window.addEventListener('message', (e: MessageEvent<{ source?: string; type?: string }>) => {
      if (e.source !== window || e.data?.source !== SOURCE || e.data.type !== 'request-captions') return;
      const v = (e.data as { videoId?: string }).videoId;
      const cached = v ? latest.get(v) : undefined;
      if (cached) {
        post(cached);
        return;
      }
      const player = document.querySelector<YtPlayer>('#movie_player');
      if (!player?.toggleSubtitles) return;
      player.loadModule?.('captions');
      // 字幕开着时播放器不一定会再请求（YouTube 会记住"字幕已开启"），先关再开就会重新请求；
      // 字幕关着则直接打开。原生字幕会被 Bilingo 隐藏，这次切换用户看不到。
      const track = player.getOption?.('captions', 'track') as { languageCode?: string } | undefined;
      player.toggleSubtitles();
      if (track?.languageCode) setTimeout(() => player.toggleSubtitles?.(), 300);
    });
  },
});
