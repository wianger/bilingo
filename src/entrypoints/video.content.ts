// 其他视频网站的双语字幕（HTML5 字幕轨道）；YouTube 由 youtube.content.ts 处理
import { setUiLang } from '@/shared/i18n';
import { DEFAULT_SETTINGS, getSettings, saveSettings, watchSettings, type Settings } from '@/shared/settings';
import { VideoSubtitles } from '@/subtitles/html5';

export default defineContentScript({
  matches: ['<all_urls>'],
  excludeMatches: ['*://www.youtube.com/*', '*://m.youtube.com/*'],
  // 视频常常放在嵌入的 iframe 里（课程平台、Vimeo 播放器）
  allFrames: true,
  runAt: 'document_idle',
  async main() {
    let settings: Settings = DEFAULT_SETTINGS;
    const subs = new VideoSubtitles(() => settings);
    subs.onToggle = (on) => void saveSettings({ videoSubtitles: on });

    settings = await getSettings();
    setUiLang(settings.uiLang);
    subs.start();
    subs.refresh();

    watchSettings((next) => {
      const prev = settings;
      settings = next;
      setUiLang(next.uiLang);
      const changed =
        prev.videoSubtitles !== next.videoSubtitles ||
        prev.provider !== next.provider ||
        prev.targetLang !== next.targetLang ||
        prev.uiLang !== next.uiLang;
      if (changed) subs.refresh();
    });
  },
});
