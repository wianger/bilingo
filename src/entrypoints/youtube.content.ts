// YouTube 双语字幕的内容脚本入口（隔离环境）；字幕请求的拦截见 youtube-main.content.ts
import { setUiLang } from '@/shared/i18n';
import { DEFAULT_SETTINGS, getSettings, saveSettings, watchSettings, type Settings } from '@/shared/settings';
import { YoutubeSubtitles } from '@/subtitles/youtube';

export default defineContentScript({
  matches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
  runAt: 'document_idle',
  async main() {
    let settings: Settings = DEFAULT_SETTINGS;
    const subs = new YoutubeSubtitles(() => settings);
    subs.onToggle = (on) => void saveSettings({ ytSubtitles: on });

    settings = await getSettings();
    setUiLang(settings.uiLang);
    subs.start();

    watchSettings((next) => {
      const prev = settings;
      settings = next;
      setUiLang(next.uiLang);
      const changed =
        prev.ytSubtitles !== next.ytSubtitles ||
        prev.provider !== next.provider ||
        prev.targetLang !== next.targetLang ||
        prev.uiLang !== next.uiLang;
      if (changed) subs.refresh();
    });
  },
});
