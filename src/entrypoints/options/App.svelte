<script lang="ts">
  import { builtinAvailability, getTranslator, hasBuiltinTranslator, translateBuiltin } from '@/shared/builtin';
  import { LANGS, sameLanguage } from '@/shared/langs';
  import type { LocalStatus } from '@/local-llm/protocol';
  import { PARTIAL_CACHE } from '@/local-llm/resumable-fetch';
  import { findPreset, LOCAL_MODELS } from '@/local-llm/models';
  import { onMessage, sendMessage } from '@/shared/messaging';
  import {
    getSettings,
    PROVIDERS_META,
    settingsItem,
    type ProviderId,
    type Settings,
    type TranslationStyle,
  } from '@/shared/settings';
  import { PROVIDER_ICONS } from '@/ui/provider-icons';
  import { modelDesc, modelLicense, modelName, providerDesc, providerName, providerTags, styleName } from '@/ui/labels';
  import { m, setUiLang, uiLocale } from '@/shared/i18n';
  import { BUILTIN_RULES, isValidSelector, ruleHost, type SiteRule } from '@/shared/site-rules';
  import { builtinRuleNote } from '@/ui/labels';
  import FileDown from '@lucide/svelte/icons/file-down';
  import FileUp from '@lucide/svelte/icons/file-up';
  import Plus from '@lucide/svelte/icons/plus';
  import Check from '@lucide/svelte/icons/check';
  import Database from '@lucide/svelte/icons/database';
  import Download from '@lucide/svelte/icons/download';
  import FlaskConical from '@lucide/svelte/icons/flask-conical';
  import Globe from '@lucide/svelte/icons/globe';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import Languages from '@lucide/svelte/icons/languages';
  import List from '@lucide/svelte/icons/list';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Palette from '@lucide/svelte/icons/palette';
  import Power from '@lucide/svelte/icons/power';
  import ShieldCheck from '@lucide/svelte/icons/shield-check';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Trash2 from '@lucide/svelte/icons/trash-2';

  // 常用 OpenAI 兼容服务。模型名会随厂商更新，可点"获取模型列表"从接口实时查询。
  const PRESETS = [
    { name: () => 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { name: m.preset_zhipu, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { name: m.preset_siliconflow, baseUrl: 'https://api.siliconflow.cn/v1', model: 'tencent/Hunyuan-MT-7B' },
    { name: m.preset_bailian, baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { name: () => 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
    { name: () => 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '' },
    { name: m.preset_ollama, baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  ];
  const BUILTIN_SOURCES = ['en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'zh'];

  let s = $state<Settings | null>(null);
  let saved = $state(false);
  let testResult = $state<{ ok: boolean | null; text: string } | null>(null);
  let models = $state<string[]>([]);
  let modelsMsg = $state('');
  /** 内置翻译各语言对的语言包状态 */
  type PackState =
    | { kind: 'available' | 'downloadable' | 'unavailable' }
    | { kind: 'downloading'; pct?: number }
    | { kind: 'failed'; msg: string };
  let builtinStatus = $state<Record<string, PackState>>({});
  /** 界面语言：变化时整个界面重新渲染 */
  let lang = $state(uiLocale());
  $effect(() => {
    if (!s) return;
    setUiLang(s.uiLang);
    lang = uiLocale();
  });
  let cacheMsg = $state('');
  let localStatus = $state<LocalStatus>({ state: 'idle' });

  const MODEL_HOSTS = [
    { label: m.host_mirror, url: 'https://hf-mirror.com/' },
    { label: m.host_hf, url: 'https://huggingface.co/' },
  ];

  // 本地模型状态：offscreen 文档存在时可查询，之后通过广播更新
  sendMessage('llmStatus', undefined)
    .then((st) => (localStatus = st))
    .catch(() => {});
  onMessage('llmStatusChanged', ({ data }) => {
    localStatus = data;
  });

  void getSettings().then((v) => {
    s = v;
    return refreshBuiltin();
  });

  // 自动保存（防抖）
  let timer = 0;
  $effect(() => {
    if (!s) return;
    const snapshot = $state.snapshot(s);
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      void settingsItem.setValue(snapshot).then(() => {
        saved = true;
        setTimeout(() => (saved = false), 1200);
      });
    }, 300);
  });

  function packText(st: PackState): string {
    switch (st.kind) {
      case 'available':
        return m.pack_available();
      case 'downloadable':
        return m.pack_downloadable();
      case 'unavailable':
        return m.pack_unavailable();
      case 'downloading':
        return st.pct === undefined ? m.pack_downloading() : m.pack_downloading_pct({ pct: st.pct });
      case 'failed':
        return m.failed_with({ msg: st.msg });
    }
  }

  async function refreshBuiltin() {
    if (!s) return;
    const target = s.targetLang;
    const next: Record<string, PackState> = {};
    for (const src of BUILTIN_SOURCES) {
      if (sameLanguage(src, target)) continue;
      try {
        const a = await builtinAvailability(src, target);
        next[src] = { kind: a === 'available' || a === 'downloadable' || a === 'downloading' ? a : 'unavailable' };
      } catch {
        next[src] = { kind: 'unavailable' };
      }
    }
    builtinStatus = next;
  }

  async function download(src: string) {
    if (!s) return;
    builtinStatus[src] = { kind: 'downloading' };
    try {
      await getTranslator(src, s.targetLang, (loaded) => {
        builtinStatus[src] = { kind: 'downloading', pct: Math.round(loaded * 100) };
      });
      builtinStatus[src] = { kind: 'available' };
    } catch (e) {
      builtinStatus[src] = { kind: 'failed', msg: (e as Error).message };
    }
  }

  async function test() {
    if (!s) return;
    testResult = { ok: null, text: m.translating() };
    const sample = s.targetLang.startsWith('zh')
      ? 'Bilingual translation keeps the original text right next to its translation.'
      : '双语对照翻译会把译文放在原文旁边。';
    try {
      let out: string[];
      if (s.provider === 'builtin') {
        out = await translateBuiltin([sample], s.targetLang);
      } else {
        out = await sendMessage('translate', { texts: [sample], override: $state.snapshot(s) });
      }
      testResult = { ok: true, text: out[0] ?? '' };
    } catch (e) {
      testResult = { ok: false, text: (e as Error).message };
    }
  }

  async function fetchModels() {
    if (!s) return;
    modelsMsg = m.openai_models_loading();
    try {
      models = await sendMessage('listModels', { baseUrl: s.openai.baseUrl, apiKey: s.openai.apiKey });
      modelsMsg = models.length ? m.openai_models_found({ n: models.length }) : m.openai_models_none();
    } catch (e) {
      modelsMsg = m.failed_with({ msg: (e as Error).message });
    }
  }

  async function clearCache() {
    await sendMessage('clearCache', undefined);
    cacheMsg = m.cache_cleared();
  }

  const hasWebGPU = 'gpu' in navigator;

  function describeLocal(st: LocalStatus): string {
    switch (st.state) {
      case 'idle':
        return m.local_state_idle();
      case 'downloading': {
        const mb = (n: number) => (n / 1e6).toFixed(0);
        if (st.total === 0) return m.local_state_preparing();
        if (st.waiting > 0) return m.local_state_connecting({ mb: mb(st.loaded) });
        return m.local_state_downloading({
          pct: (st.progress * 100).toFixed(1),
          loaded: mb(st.loaded),
          total: mb(st.total),
        });
      }
      case 'loading':
        return m.local_state_loading();
      case 'ready':
        return m.local_state_ready({ adapter: st.adapter, dtype: st.dtype });
      case 'error':
        return st.message;
    }
  }

  async function prepareLocal() {
    localStatus = { state: 'downloading', progress: 0, loaded: 0, total: 0, waiting: 0 };
    await sendMessage('localPrepare', undefined);
  }

  async function unloadLocal() {
    await sendMessage('localUnload', undefined);
    localStatus = { state: 'idle' };
  }

  // ---- 本地模型选择 ----
  let customModel = $state(false);
  let localMsg = $state('');
  /** 每个模型在本机的下载情况：done 已完整下载 / partial 下载了一部分 */
  let modelFiles = $state<Record<string, 'done' | 'partial'>>({});
  const preset = $derived(s ? findPreset(s.local.model.trim()) : undefined);

  const repoOf = (url: string) => LOCAL_MODELS.map((m) => m.repo).find((r) => url.includes(`/${r}/`));

  async function refreshModelFiles() {
    const next: Record<string, 'done' | 'partial'> = {};
    const custom = s?.local.model.trim();
    const match = (url: string) => repoOf(url) ?? (custom && url.includes(`/${custom}/`) ? custom : undefined);
    for (const req of await (await caches.open('transformers-cache')).keys()) {
      const repo = match(req.url);
      if (repo && /\.onnx_data/.test(req.url)) next[repo] = 'done';
    }
    for (const req of await (await caches.open(PARTIAL_CACHE)).keys()) {
      const repo = match(req.url);
      if (repo && !next[repo]) next[repo] = 'partial';
    }
    modelFiles = next;
  }
  void refreshModelFiles();
  $effect(() => {
    if (localStatus.state === 'ready' || localStatus.state === 'idle') void refreshModelFiles();
  });

  function chooseModel(value: string) {
    if (!s) return;
    if (value === '__custom') {
      customModel = true;
      return;
    }
    customModel = false;
    s.local.model = value;
    localMsg = '';
  }

  /** 只删除当前选中模型的文件（含未下载完的分块） */
  async function deleteLocalModel() {
    if (!s) return;
    await unloadLocal();
    const repo = s.local.model.trim();
    let n = 0;
    for (const name of ['transformers-cache', PARTIAL_CACHE]) {
      const cache = await caches.open(name);
      for (const req of await cache.keys()) {
        if (req.url.includes(`/${repo}/`) && (await cache.delete(req))) n++;
      }
    }
    localMsg = n ? m.local_deleted({ n, repo }) : m.local_none_found();
    await refreshModelFiles();
  }

  const STYLES: TranslationStyle[] = ['faded', 'plain', 'underline', 'highlight', 'quote'];

  const NAV = [
    { id: 'general', name: m.nav_general, icon: Languages },
    { id: 'provider', name: m.nav_engine, icon: Sparkles },
    { id: 'sites', name: m.nav_sites, icon: List },
    { id: 'other', name: m.nav_other, icon: Database },
  ];
  let current = $state('general');
  // 滚动时高亮当前所在分区（scroll-margin 与 rootMargin 对齐）
  $effect(() => {
    if (!s) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) current = e.target.id;
      },
      { rootMargin: '-20% 0px -70% 0px' },
    );
    for (const n of NAV) {
      const el = document.getElementById(n.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  });

  // ---- 网站规则 ----
  let rulesMsg = $state('');
  const lines = (v: string) =>
    v
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean);
  const badSelectors = (r: SiteRule) => [...(r.include ?? []), ...(r.exclude ?? [])].filter((x) => !isValidSelector(x));

  function addRule() {
    s!.siteRules.push({ id: `user:${Date.now().toString(36)}`, matches: [] });
  }

  function toggleBuiltin(id: string, on: boolean) {
    const rest = s!.disabledBuiltinRules.filter((x) => x !== id);
    s!.disabledBuiltinRules = on ? rest : [...rest, id];
  }

  function exportRules() {
    const blob = new Blob([JSON.stringify({ bilingoSiteRules: 1, rules: $state.snapshot(s!.siteRules) }, null, 2)], {
      type: 'application/json',
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bilingo-site-rules.json';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** 导入：接受规则数组或 { rules: [...] }；同 id 的规则会被替换 */
  async function importRules(file: File | undefined) {
    if (!file || !s) return;
    try {
      const data = JSON.parse(await file.text()) as unknown;
      const list = Array.isArray(data) ? data : (data as { rules?: unknown }).rules;
      if (!Array.isArray(list)) throw new Error('expected an array of rules');
      const rules = list.map((r: Partial<SiteRule>, i): SiteRule => {
        if (!r || !Array.isArray(r.matches) || !r.matches.every((x) => typeof x === 'string')) {
          throw new Error(`rule ${i + 1}: "matches" must be a list of websites`);
        }
        const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
        return {
          id: typeof r.id === 'string' && r.id ? r.id : `user:${Date.now().toString(36)}${i}`,
          matches: r.matches,
          include: strs(r.include),
          exclude: strs(r.exclude),
          css: typeof r.css === 'string' ? r.css : undefined,
        };
      });
      const ids = new Set(rules.map((r) => r.id));
      s.siteRules = [...s.siteRules.filter((r) => !ids.has(r.id)), ...rules];
      rulesMsg = m.rules_imported({ n: rules.length });
    } catch (e) {
      rulesMsg = m.rules_import_failed({ msg: (e as Error).message });
    }
  }

  const localBusy = $derived(localStatus.state === 'downloading' || localStatus.state === 'loading');
</script>

{#if s}
  {#key lang}
    <div class="layout">
      <aside>
        <div class="brand">
          <img src="/icon/48.png" alt="" width="32" height="32" />
          <div>
            <b>Bilingo</b>
            <span class="muted">{m.app_tagline()}</span>
          </div>
        </div>
        <nav>
          {#each NAV as n (n.id)}
            <a href="#{n.id}" class:active={current === n.id}><n.icon size={16} />{n.name()}</a>
          {/each}
        </nav>
        <p class="muted privacy"><ShieldCheck size={14} /> {m.opt_privacy()}</p>
      </aside>

      <main>
        <header>
          <h1>{m.settings()}</h1>
          <span class="saved" class:show={saved}><Check size={14} /> {m.opt_saved()}</span>
        </header>

        <section id="general" class="card">
          <h2><Languages size={18} /> {m.nav_general()}</h2>
          <div class="grid2">
            <label class="field">
              <span>{m.target_language()}</span>
              <select class="select" bind:value={s.targetLang} onchange={refreshBuiltin}>
                {#each LANGS as l (l.code)}<option value={l.code}>{l.name}</option>{/each}
              </select>
            </label>
            <label class="field">
              <span>{m.opt_ui_language()}</span>
              <select class="select" bind:value={s.uiLang}>
                <option value="auto">{m.opt_ui_auto()}</option>
                <option value="en">English</option>
                <option value="zh-CN">简体中文</option>
              </select>
            </label>
          </div>

          <div class="field">
            <span><Palette size={13} /> {m.opt_style()}</span>
            <div class="styles" role="radiogroup" aria-label={m.opt_style()}>
              {#each STYLES as st (st)}
                <label class="style-card" class:selected={s.style === st}>
                  <input type="radio" name="style" value={st} bind:group={s.style} />
                  <span class="sample-src">Hello world</span>
                  <span class="sample-tr tr-{st}">你好，世界</span>
                  <span class="style-name">{styleName(st)}</span>
                </label>
              {/each}
            </div>
          </div>

          <label class="row">
            <div>
              <div>{m.opt_main_only()}</div>
              <div class="muted">{m.opt_main_only_desc()}</div>
            </div>
            <input
              type="checkbox"
              class="switch"
              checked={s.scope !== 'all'}
              onchange={(e) => (s!.scope = e.currentTarget.checked ? 'smart' : 'all')}
            />
          </label>

          <label class="row">
            <div>
              <div>{m.opt_float_ball()}</div>
              <div class="muted">{m.opt_float_ball_desc()}</div>
            </div>
            <input type="checkbox" class="switch" bind:checked={s.floatBall} />
          </label>

          <label class="row">
            <div>
              <div>{m.opt_yt()}</div>
              <div class="muted">{m.opt_yt_desc()}</div>
            </div>
            <input type="checkbox" class="switch" bind:checked={s.ytSubtitles} />
          </label>
        </section>

        <section id="provider" class="card">
          <h2><Sparkles size={18} /> {m.translation_engine()}</h2>
          <div class="providers" role="radiogroup" aria-label={m.translation_engine()}>
            {#each Object.keys(PROVIDERS_META) as ProviderId[] as id (id)}
              {@const Icon = PROVIDER_ICONS[id]}
              <label class="provider" class:selected={s.provider === id}>
                <input type="radio" name="provider" value={id} bind:group={s.provider} />
                <span class="p-icon"><Icon size={18} /></span>
                <span class="p-body">
                  <b>{providerName(id)}</b>
                  <span class="muted">{providerDesc(id)}</span>
                  <span class="tags">
                    {#each providerTags(id) as t (t.text)}<span class="badge" class:ok={t.free}>{t.text}</span>{/each}
                  </span>
                </span>
              </label>
            {/each}
          </div>

          <div class="panel">
            {#if s.provider === 'builtin'}
              <p class="muted">{m.builtin_desc()}</p>
              {#if !hasBuiltinTranslator()}
                <p class="alert err">{m.builtin_unsupported_alert()}</p>
              {/if}
              <div class="pairs">
                {#each Object.entries(builtinStatus) as [src, st] (src)}
                  <div class="pair">
                    <span>{LANGS.find((l) => l.code === src || l.code.startsWith(src + '-'))?.name ?? src}</span>
                    <span class="muted">{m.builtin_to_target()}</span>
                    <span
                      class="badge"
                      class:ok={st.kind === 'available'}
                      class:accent={st.kind === 'downloading'}
                      class:err={st.kind === 'failed'}
                    >
                      {packText(st)}
                    </span>
                    {#if st.kind === 'downloadable'}
                      <button class="btn sm" onclick={() => download(src)}>
                        <Download size={13} />
                        {m.download()}
                      </button>
                    {:else}
                      <span></span>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if s.provider === 'local'}
              <p class="muted">{m.local_desc()}</p>
              {#if !hasWebGPU}<p class="alert err">{m.local_no_webgpu_alert()}</p>{/if}
              <div class="grid2">
                <label class="field">
                  <span>{m.local_model()}</span>
                  <select
                    class="select"
                    value={customModel || !preset ? '__custom' : preset.repo}
                    onchange={(e) => chooseModel(e.currentTarget.value)}
                  >
                    {#each LOCAL_MODELS as lm (lm.repo)}
                      <option value={lm.repo}>{modelName(lm)}</option>
                    {/each}
                    <option value="__custom">{m.local_custom()}</option>
                  </select>
                </label>
                <label class="field">
                  <span>{m.local_source()}</span>
                  <select class="select" bind:value={s.local.host}>
                    {#each MODEL_HOSTS as h (h.url)}<option value={h.url}>{h.label()}</option>{/each}
                  </select>
                </label>
              </div>

              {#if customModel || !preset}
                <label class="field">
                  <span>{m.local_custom_repo()}</span>
                  <input class="input" placeholder={m.local_custom_placeholder()} bind:value={s.local.model} />
                </label>
              {/if}

              <div class="model-info">
                {#if preset && !customModel}
                  <p>{modelDesc(preset)}</p>
                  <div class="tags">
                    <span class="badge">{m.local_size({ size: (preset.sizeMB / 1000).toFixed(1) })}</span>
                    <span class="badge">{modelLicense(preset)}</span>
                    {#if preset.experimental}<span class="badge accent">{m.local_experimental()}</span>{/if}
                    {#if modelFiles[preset.repo] === 'done'}<span class="badge ok">{m.local_downloaded()}</span>
                    {:else if modelFiles[preset.repo] === 'partial'}<span class="badge accent">
                        {m.local_partial()}
                      </span>
                    {:else}<span class="badge">{m.local_not_downloaded()}</span>{/if}
                  </div>
                {:else}
                  <p>{m.local_custom_untested()}</p>
                {/if}
              </div>

              <div class="status" data-state={localStatus.state}>
                <div class="status-line">
                  {#if localBusy}<LoaderCircle size={15} class="spin" />{:else if localStatus.state === 'ready'}<Check
                      size={15}
                    />{:else}<Power size={15} />{/if}
                  <span>{describeLocal(localStatus)}</span>
                </div>
                {#if localStatus.state === 'downloading'}
                  <div class="progress"><div style:width="{localStatus.progress * 100}%"></div></div>
                {:else if localStatus.state === 'loading'}
                  <div class="progress indeterminate"><div></div></div>
                {/if}
              </div>

              <div class="actions">
                <button class="btn primary" onclick={prepareLocal} disabled={localBusy}>
                  <Download size={15} />
                  {m.local_load()}
                </button>
                <button class="btn" onclick={unloadLocal}><Power size={15} /> {m.local_unload()}</button>
                <button class="btn danger" onclick={deleteLocalModel}><Trash2 size={15} /> {m.local_delete()}</button>
              </div>
              {#if localMsg}<p class="muted">{localMsg}</p>{/if}
            {/if}

            {#if s.provider === 'openai'}
              <p class="muted">{m.openai_desc()}</p>
              <div class="field">
                <span>{m.openai_presets()}</span>
                <div class="presets">
                  {#each PRESETS as p (p.baseUrl)}
                    <button
                      class="btn sm"
                      class:on={s.openai.baseUrl === p.baseUrl}
                      onclick={() => ((s!.openai.baseUrl = p.baseUrl), (s!.openai.model = p.model))}
                    >
                      {p.name()}
                    </button>
                  {/each}
                </div>
              </div>
              <label class="field">
                <span>{m.openai_base_url()}</span><input class="input" bind:value={s.openai.baseUrl} />
              </label>
              <label class="field">
                <span><KeyRound size={13} /> {m.openai_api_key()}</span>
                <input class="input" type="password" autocomplete="off" bind:value={s.openai.apiKey} />
              </label>
              <div class="field">
                <span>{m.local_model()}</span>
                <div class="inline">
                  <input class="input" list="models" aria-label={m.local_model()} bind:value={s.openai.model} />
                  <button class="btn" onclick={fetchModels}>{m.openai_fetch_models()}</button>
                </div>
                <datalist id="models">
                  {#each models as m (m)}<option value={m}></option>{/each}
                </datalist>
                {#if modelsMsg}<span class="muted">{modelsMsg}</span>{/if}
              </div>
              <details>
                <summary>{m.openai_advanced()}</summary>
                <div class="grid4">
                  <label class="field">
                    <span>{m.openai_temperature()}</span>
                    <input
                      class="input"
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={s.openai.temperature ?? ''}
                      oninput={(e) =>
                        (s!.openai.temperature = e.currentTarget.value === '' ? null : Number(e.currentTarget.value))}
                    />
                  </label>
                  <label class="field">
                    <span>{m.openai_batch_chars()}</span>
                    <input class="input" type="number" min="200" step="100" bind:value={s.openai.maxBatchChars} />
                  </label>
                  <label class="field">
                    <span>{m.openai_batch_items()}</span>
                    <input class="input" type="number" min="1" max="50" bind:value={s.openai.maxBatchItems} />
                  </label>
                  <label class="field">
                    <span>{m.openai_concurrency()}</span>
                    <input class="input" type="number" min="1" max="20" bind:value={s.openai.concurrency} />
                  </label>
                </div>
                <label class="field">
                  <span>{m.openai_prompt()}</span>
                  <textarea
                    class="input"
                    rows="3"
                    placeholder={m.openai_prompt_placeholder()}
                    bind:value={s.openai.prompt}></textarea>
                </label>
                <p class="muted">
                  {m.openai_ollama_before()} <code>OLLAMA_ORIGINS=chrome-extension://*</code>
                  {m.openai_ollama_after()}
                </p>
              </details>
            {/if}

            {#if s.provider === 'azure'}
              <p class="muted">{m.azure_desc()}</p>
              <div class="grid2">
                <label class="field">
                  <span><KeyRound size={13} /> {m.azure_key()}</span>
                  <input class="input" type="password" autocomplete="off" bind:value={s.azure.key} />
                </label>
                <label class="field">
                  <span>{m.azure_region()}</span><input class="input" bind:value={s.azure.region} />
                </label>
              </div>
            {/if}

            {#if s.provider === 'deepl'}
              <p class="muted">{m.deepl_desc()}</p>
              <label class="field">
                <span><KeyRound size={13} /> {m.deepl_key()}</span>
                <input class="input" type="password" autocomplete="off" bind:value={s.deepl.key} />
              </label>
            {/if}

            {#if s.provider === 'google'}
              <p class="muted">{m.google_desc()}</p>
            {/if}

            <div class="test">
              <button class="btn" onclick={test} disabled={testResult?.ok === null}>
                {#if testResult?.ok === null}<LoaderCircle size={15} class="spin" />{:else}<FlaskConical
                    size={15}
                  />{/if}
                {m.test_engine()}
              </button>
              {#if testResult && testResult.ok !== null}
                <span class="test-result" class:ok={testResult.ok} class:err={!testResult.ok}>{testResult.text}</span>
              {/if}
            </div>
          </div>
        </section>

        <section id="sites" class="card">
          <h2><Globe size={18} /> {m.sites_title()}</h2>
          <label class="field">
            <span>{m.sites_desc()}</span>
            <textarea
              class="input"
              rows="4"
              value={s.autoSites.join('\n')}
              onchange={(e) => (s!.autoSites = e.currentTarget.value.split(/\s+/).filter(Boolean))}></textarea>
          </label>

          <div class="rules">
            <h3>{m.rules_title()}</h3>
            <p class="muted">{m.rules_desc()}</p>

            {#if BUILTIN_RULES.length}
              <div class="field">
                <span>{m.rules_builtin()}</span>
                {#each BUILTIN_RULES as r (r.id)}
                  <label class="row builtin-rule">
                    <div>
                      <div><code>{ruleHost(r)}</code></div>
                      <div class="muted">{builtinRuleNote(r.id) ?? r.note}</div>
                    </div>
                    <input
                      type="checkbox"
                      class="switch"
                      checked={!s.disabledBuiltinRules.includes(r.id)}
                      onchange={(e) => toggleBuiltin(r.id, e.currentTarget.checked)}
                    />
                  </label>
                {/each}
              </div>
            {/if}

            <div class="field">
              <span>{m.rules_user()}</span>
              {#each s.siteRules as rule, i (rule.id)}
                {@const bad = badSelectors(rule)}
                <div class="rule">
                  <div class="rule-head">
                    <b>{ruleHost(rule) || m.rules_new_site()}</b>
                    <button class="btn sm danger" onclick={() => s!.siteRules.splice(i, 1)}>
                      <Trash2 size={13} />
                      {m.rules_delete()}
                    </button>
                  </div>
                  <label class="field">
                    <span>{m.rules_matches()}</span>
                    <textarea
                      class="input mono"
                      rows="1"
                      value={rule.matches.join('\n')}
                      onchange={(e) => (rule.matches = lines(e.currentTarget.value))}></textarea>
                  </label>
                  <div class="grid2">
                    <label class="field">
                      <span>{m.rules_include()}</span>
                      <textarea
                        class="input mono"
                        rows="2"
                        value={(rule.include ?? []).join('\n')}
                        onchange={(e) => (rule.include = lines(e.currentTarget.value))}></textarea>
                    </label>
                    <label class="field">
                      <span>{m.rules_exclude()}</span>
                      <textarea
                        class="input mono"
                        rows="2"
                        value={(rule.exclude ?? []).join('\n')}
                        onchange={(e) => (rule.exclude = lines(e.currentTarget.value))}></textarea>
                    </label>
                  </div>
                  <label class="field">
                    <span>{m.rules_css()}</span>
                    <textarea class="input mono" rows="1" bind:value={rule.css}></textarea>
                  </label>
                  {#each bad as sel (sel)}<p class="alert err">{m.rules_invalid({ sel })}</p>{/each}
                </div>
              {:else}
                <p class="muted">{m.rules_empty()}</p>
              {/each}
            </div>

            <div class="actions">
              <button class="btn" onclick={addRule}><Plus size={15} /> {m.rules_add()}</button>
              <label class="btn">
                <FileUp size={15} />
                {m.rules_import()}
                <input
                  type="file"
                  accept="application/json,.json"
                  hidden
                  onchange={(e) => void importRules(e.currentTarget.files?.[0])}
                />
              </label>
              <button class="btn" onclick={exportRules} disabled={!s.siteRules.length}>
                <FileDown size={15} />
                {m.rules_export()}
              </button>
            </div>
            {#if rulesMsg}<p class="muted">{rulesMsg}</p>{/if}
          </div>
        </section>

        <section id="other" class="card">
          <h2><Database size={18} /> {m.nav_other()}</h2>
          <div class="row">
            <div>
              <div>{m.shortcut_title()}</div>
              <div class="muted">{m.shortcut_default()} <kbd>Alt</kbd> + <kbd>A</kbd></div>
              <div class="muted">
                {m.shortcut_change()} <code>edge://extensions/shortcuts</code> ·
                <code>chrome://extensions/shortcuts</code>
              </div>
            </div>
          </div>
          <div class="row">
            <div>
              <div>{m.cache_title()}</div>
              <div class="muted">{m.cache_desc()} {cacheMsg}</div>
            </div>
            <button class="btn danger" onclick={clearCache}><Trash2 size={15} /> {m.cache_clear()}</button>
          </div>
        </section>
      </main>
    </div>
  {/key}
{/if}

<style>
  .layout {
    display: grid;
    grid-template-columns: 220px minmax(0, 760px);
    justify-content: center;
    gap: 40px;
    padding: 32px 24px 80px;
  }
  aside {
    position: sticky;
    top: 32px;
    align-self: start;
    display: grid;
    gap: 24px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 8px;
  }
  .brand b {
    display: block;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  nav {
    display: grid;
    gap: 2px;
  }
  nav a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius-s);
    color: var(--muted);
    font-weight: 500;
    text-decoration: none;
    transition:
      background 0.15s var(--ease),
      color 0.15s var(--ease);
  }
  nav a:hover {
    color: var(--fg);
    background: var(--surface-2);
  }
  nav a.active {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .privacy {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
  }
  main {
    display: grid;
    gap: 20px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 40px;
  }
  h1 {
    font-size: 24px;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .saved {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: 999px;
    font-size: 12px;
    color: var(--ok);
    background: var(--ok-soft);
    opacity: 0;
    translate: 0 4px;
    transition:
      opacity 0.2s var(--ease),
      translate 0.2s var(--ease);
  }
  .saved.show {
    opacity: 1;
    translate: 0 0;
  }
  section {
    display: grid;
    gap: 16px;
    padding: 22px 24px;
    scroll-margin-top: 24px;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 16px;
    font-weight: 600;
  }
  h2 :global(svg) {
    color: var(--accent);
  }
  .field {
    display: grid;
    gap: 6px;
  }
  .field > span:first-child {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--muted);
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .row .muted {
    margin-top: 2px;
  }
  .grid2,
  .grid4 {
    display: grid;
    gap: 12px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .grid4 {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
  .inline {
    display: flex;
    gap: 8px;
  }

  /* 单选卡片（译文样式 / 翻译服务） */
  .style-card,
  .provider {
    position: relative;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    cursor: pointer;
    transition:
      border-color 0.15s var(--ease),
      background 0.15s var(--ease),
      box-shadow 0.15s var(--ease);
  }
  .style-card:hover,
  .provider:hover {
    border-color: var(--border-strong);
  }
  .style-card.selected,
  .provider.selected {
    border-color: var(--accent);
    background: var(--accent-soft);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .style-card:has(:focus-visible),
  .provider:has(:focus-visible) {
    box-shadow: var(--ring);
  }
  .style-card input,
  .provider input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }
  .styles {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }
  .style-card {
    display: grid;
    gap: 2px;
    padding: 10px 12px;
    font-size: 13px;
  }
  .style-name {
    margin-top: 6px;
    font-size: 12px;
    color: var(--muted);
  }
  .selected .style-name {
    color: var(--accent);
    font-weight: 600;
  }
  .sample-tr {
    justify-self: start;
  }
  .tr-faded {
    opacity: 0.62;
  }
  .tr-underline {
    text-decoration: underline dashed color-mix(in oklch, var(--accent) 70%, transparent);
    text-underline-offset: 4px;
  }
  .tr-highlight {
    background: oklch(0.9 0.15 95 / 0.45);
    border-radius: 3px;
    padding: 0 2px;
  }
  .tr-quote {
    border-left: 3px solid var(--accent);
    padding-left: 6px;
  }

  .providers {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 10px;
  }
  .provider {
    display: flex;
    gap: 12px;
    padding: 14px;
  }
  .p-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    color: var(--muted);
    background: var(--surface-2);
    flex: none;
    transition:
      color 0.15s,
      background 0.15s;
  }
  .selected .p-icon {
    color: var(--on-accent);
    background: var(--gradient);
  }
  .p-body {
    display: grid;
    gap: 3px;
    min-width: 0;
  }
  .p-body b {
    font-weight: 600;
  }
  .p-body .muted {
    font-size: 12px;
    line-height: 1.45;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }

  .panel {
    display: grid;
    gap: 14px;
    padding: 18px;
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .panel :global(.input),
  .panel :global(.select) {
    background-color: var(--surface);
  }
  .alert {
    padding: 8px 12px;
    border-radius: var(--radius-s);
    background: var(--err-soft);
    font-size: 13px;
  }
  .pairs {
    display: grid;
    gap: 2px;
  }
  .pair {
    display: grid;
    grid-template-columns: 90px 1fr auto 72px;
    align-items: center;
    gap: 10px;
    min-height: 34px;
  }
  .pair .btn {
    justify-self: end;
  }
  .model-info {
    display: grid;
    gap: 8px;
    font-size: 13px;
  }
  .model-info .tags {
    margin-top: 0;
  }
  .status {
    display: grid;
    gap: 10px;
    padding: 12px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-s);
    background: var(--surface);
  }
  .status-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .status[data-state='ready'] .status-line {
    color: var(--ok);
  }
  .status[data-state='error'] .status-line {
    color: var(--err);
  }
  .status[data-state='downloading'] .status-line,
  .status[data-state='loading'] .status-line {
    color: var(--accent);
  }
  .actions,
  .presets {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .presets .on {
    border-color: var(--accent);
    color: var(--accent);
    background: var(--accent-soft);
  }
  details {
    display: grid;
    gap: 14px;
  }
  details[open] {
    display: grid;
  }
  details > :not(summary) {
    margin-top: 14px;
  }
  summary {
    width: fit-content;
    font-size: 13px;
    font-weight: 500;
    color: var(--muted);
    cursor: pointer;
  }
  summary:hover {
    color: var(--fg);
  }
  .rules {
    display: grid;
    gap: 14px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }
  h3 {
    font-size: 15px;
    font-weight: 600;
  }
  .builtin-rule {
    padding-top: 8px;
    border-top: none;
  }
  .rule {
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-2);
  }
  .rule :global(.input) {
    background-color: var(--surface);
  }
  .rule-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .mono {
    font-family: ui-monospace, 'Cascadia Code', Consolas, monospace;
    font-size: 12.5px;
  }
  .test {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
  }
  .test-result {
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 5px;
    font:
      500 11px/1.4 ui-monospace,
      Consolas,
      monospace;
    background: var(--surface);
  }

  @media (max-width: 860px) {
    .layout {
      grid-template-columns: minmax(0, 1fr);
      gap: 20px;
    }
    aside {
      position: static;
    }
    nav {
      display: flex;
      flex-wrap: wrap;
    }
    .privacy {
      display: none;
    }
    .styles {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .grid4 {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
