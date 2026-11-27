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
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'tencent/Hunyuan-MT-7B' },
    { name: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '' },
    { name: 'Ollama 本地', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  ];
  const BUILTIN_SOURCES = ['en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'zh'];

  let s = $state<Settings | null>(null);
  let saved = $state(false);
  let testResult = $state<{ ok: boolean | null; text: string } | null>(null);
  let models = $state<string[]>([]);
  let modelsMsg = $state('');
  let builtinStatus = $state<Record<string, string>>({});
  let cacheMsg = $state('');
  let localStatus = $state<LocalStatus>({ state: 'idle' });

  const MODEL_HOSTS = [
    { label: 'hf-mirror 镜像（国内推荐）', url: 'https://hf-mirror.com/' },
    { label: 'Hugging Face 官方', url: 'https://huggingface.co/' },
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

  const STATUS_TEXT: Record<string, string> = {
    available: '已就绪',
    downloadable: '可下载',
    downloading: '下载中…',
    unavailable: '不支持',
    unsupported: '浏览器不支持',
  };

  async function refreshBuiltin() {
    if (!s) return;
    const target = s.targetLang;
    const next: Record<string, string> = {};
    for (const src of BUILTIN_SOURCES) {
      if (sameLanguage(src, target)) continue;
      try {
        next[src] = await builtinAvailability(src, target);
      } catch (e) {
        next[src] = 'unavailable';
      }
    }
    builtinStatus = next;
  }

  async function download(src: string) {
    if (!s) return;
    builtinStatus[src] = 'downloading';
    try {
      await getTranslator(src, s.targetLang, (loaded) => {
        builtinStatus[src] = `下载中 ${Math.round(loaded * 100)}%`;
      });
      builtinStatus[src] = 'available';
    } catch (e) {
      builtinStatus[src] = `失败：${(e as Error).message}`;
    }
  }

  async function test() {
    if (!s) return;
    testResult = { ok: null, text: '翻译中…' };
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
    modelsMsg = '获取中…';
    try {
      models = await sendMessage('listModels', { baseUrl: s.openai.baseUrl, apiKey: s.openai.apiKey });
      modelsMsg = models.length ? `共 ${models.length} 个模型，可在输入框下拉选择` : '接口没有返回模型';
    } catch (e) {
      modelsMsg = `失败：${(e as Error).message}`;
    }
  }

  async function clearCache() {
    await sendMessage('clearCache', undefined);
    cacheMsg = '已清空';
  }

  const hasWebGPU = 'gpu' in navigator;

  function describeLocal(st: LocalStatus): string {
    switch (st.state) {
      case 'idle':
        return '未加载';
      case 'downloading': {
        const mb = (n: number) => (n / 1e6).toFixed(0);
        if (st.total === 0) return '正在准备模型文件…';
        if (st.waiting > 0) return `已下载 ${mb(st.loaded)} MB，正在连接下载服务器…`;
        return `下载中 ${(st.progress * 100).toFixed(1)}%（${mb(st.loaded)} / ${mb(st.total)} MB）`;
      }
      case 'loading':
        return '正在加载到显卡…';
      case 'ready':
        return `已就绪 · ${st.adapter} · ${st.dtype}`;
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
    localMsg = n ? `已删除 ${repo} 的 ${n} 个文件` : '本机没有该模型的文件';
    await refreshModelFiles();
  }

  const STYLES: { id: TranslationStyle; name: string }[] = [
    { id: 'faded', name: '淡化' },
    { id: 'plain', name: '普通' },
    { id: 'underline', name: '虚线' },
    { id: 'highlight', name: '高亮' },
    { id: 'quote', name: '引用线' },
  ];

  const NAV = [
    { id: 'general', name: '基础', icon: Languages },
    { id: 'provider', name: '翻译服务', icon: Sparkles },
    { id: 'sites', name: '网站', icon: List },
    { id: 'other', name: '其他', icon: Database },
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

  const localBusy = $derived(localStatus.state === 'downloading' || localStatus.state === 'loading');
</script>

{#if s}
  <div class="layout">
    <aside>
      <div class="brand">
        <img src="/icon/48.png" alt="" width="32" height="32" />
        <div>
          <b>Bilingo</b>
          <span class="muted">双语网页翻译</span>
        </div>
      </div>
      <nav>
        {#each NAV as n (n.id)}
          <a href="#{n.id}" class:active={current === n.id}><n.icon size={16} />{n.name}</a>
        {/each}
      </nav>
      <p class="muted privacy"><ShieldCheck size={14} /> 设置与密钥只保存在本机</p>
    </aside>

    <main>
      <header>
        <h1>设置</h1>
        <span class="saved" class:show={saved}><Check size={14} /> 已自动保存</span>
      </header>

      <section id="general" class="card">
        <h2><Languages size={18} /> 基础</h2>
        <label class="field">
          <span>目标语言</span>
          <select class="select" bind:value={s.targetLang} onchange={refreshBuiltin}>
            {#each LANGS as l (l.code)}<option value={l.code}>{l.name}</option>{/each}
          </select>
        </label>

        <div class="field">
          <span><Palette size={13} /> 译文样式</span>
          <div class="styles" role="radiogroup" aria-label="译文样式">
            {#each STYLES as st (st.id)}
              <label class="style-card" class:selected={s.style === st.id}>
                <input type="radio" name="style" value={st.id} bind:group={s.style} />
                <span class="sample-src">Hello world</span>
                <span class="sample-tr tr-{st.id}">你好，世界</span>
                <span class="style-name">{st.name}</span>
              </label>
            {/each}
          </div>
        </div>

        <label class="row">
          <div>
            <div>只翻译正文</div>
            <div class="muted">
              跳过导航栏、菜单、按钮、页眉页脚和代码标识符等，不翻译网页的“界面文字”。关闭后翻译页面上的所有文字
            </div>
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
            <div>悬浮翻译按钮</div>
            <div class="muted">在网页边缘显示可拖动的“译”按钮</div>
          </div>
          <input type="checkbox" class="switch" bind:checked={s.floatBall} />
        </label>
      </section>

      <section id="provider" class="card">
        <h2><Sparkles size={18} /> 翻译服务</h2>
        <div class="providers" role="radiogroup" aria-label="翻译服务">
          {#each Object.entries(PROVIDERS_META) as [id, m] (id)}
            {@const Icon = PROVIDER_ICONS[id as ProviderId]}
            <label class="provider" class:selected={s.provider === id}>
              <input type="radio" name="provider" value={id} bind:group={s.provider} />
              <span class="p-icon"><Icon size={18} /></span>
              <span class="p-body">
                <b>{m.name}</b>
                <span class="muted">{m.desc}</span>
                <span class="tags">
                  {#each m.tags as t (t)}<span class="badge" class:ok={t === '免费'}>{t}</span>{/each}
                </span>
              </span>
            </label>
          {/each}
        </div>

        <div class="panel">
          {#if s.provider === 'builtin'}
            <p class="muted">
              使用 Chrome 138+ / Edge 148+
              自带的本地翻译模型：完全免费、不联网、文本不出本机。每个语言对首次使用需下载语言包。
            </p>
            {#if !hasBuiltinTranslator()}
              <p class="alert err">当前浏览器不支持内置翻译，请换用其他翻译服务。</p>
            {/if}
            <div class="pairs">
              {#each Object.entries(builtinStatus) as [src, st] (src)}
                <div class="pair">
                  <span>{LANGS.find((l) => l.code === src || l.code.startsWith(src + '-'))?.name ?? src}</span>
                  <span class="muted">→ 目标语言</span>
                  <span
                    class="badge"
                    class:ok={st === 'available'}
                    class:accent={st.startsWith('下载中') || st === 'downloading'}
                    class:err={st.startsWith('失败')}
                  >
                    {STATUS_TEXT[st] ?? st}
                  </span>
                  {#if st === 'downloadable'}
                    <button class="btn sm" onclick={() => download(src)}><Download size={13} /> 下载</button>
                  {:else}
                    <span></span>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}

          {#if s.provider === 'local'}
            <p class="muted">
              在你的显卡上运行开源翻译模型：免费、离线、文本不出本机。首次使用需下载模型，之后从本地缓存加载；空闲 10
              分钟后自动卸载以释放显存。需要支持 WebGPU 的 Chrome / Edge 桌面版。
            </p>
            {#if !hasWebGPU}<p class="alert err">当前浏览器不支持 WebGPU，无法使用本地大模型。</p>{/if}
            <div class="grid2">
              <label class="field">
                <span>模型</span>
                <select
                  class="select"
                  value={customModel || !preset ? '__custom' : preset.repo}
                  onchange={(e) => chooseModel(e.currentTarget.value)}
                >
                  {#each LOCAL_MODELS as m (m.repo)}
                    <option value={m.repo}>{m.name}</option>
                  {/each}
                  <option value="__custom">自定义…</option>
                </select>
              </label>
              <label class="field">
                <span>模型下载源</span>
                <select class="select" bind:value={s.local.host}>
                  {#each MODEL_HOSTS as h (h.url)}<option value={h.url}>{h.label}</option>{/each}
                </select>
              </label>
            </div>

            {#if customModel || !preset}
              <label class="field">
                <span>
                  Hugging Face 仓库 id（需为 Transformers.js 可加载的 ONNX 文本生成模型，按 Hy-MT 指令格式调用）
                </span>
                <input class="input" placeholder="例如 drnfns/Hy-MT2-1.8B-ONNX" bind:value={s.local.model} />
              </label>
            {/if}

            <div class="model-info">
              {#if preset && !customModel}
                <p>{preset.desc}</p>
                <div class="tags">
                  <span class="badge">约 {(preset.sizeMB / 1000).toFixed(1)} GB</span>
                  <span class="badge">{preset.license}</span>
                  {#if preset.experimental}<span class="badge accent">实验性</span>{/if}
                  {#if modelFiles[preset.repo] === 'done'}<span class="badge ok">已下载</span>
                  {:else if modelFiles[preset.repo] === 'partial'}<span class="badge accent">已下载一部分，可续传</span>
                  {:else}<span class="badge">未下载</span>{/if}
                </div>
              {:else}
                <p>自定义模型未经测试，翻译效果取决于模型本身。</p>
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
                <Download size={15} /> 下载 / 加载模型
              </button>
              <button class="btn" onclick={unloadLocal}><Power size={15} /> 卸载（释放显存）</button>
              <button class="btn danger" onclick={deleteLocalModel}><Trash2 size={15} /> 删除此模型文件</button>
            </div>
            {#if localMsg}<p class="muted">{localMsg}</p>{/if}
          {/if}

          {#if s.provider === 'openai'}
            <p class="muted">API Key 只保存在本机浏览器，请求直接发往你填写的接口地址，不经过任何第三方服务器。</p>
            <div class="field">
              <span>快速填入</span>
              <div class="presets">
                {#each PRESETS as p (p.name)}
                  <button
                    class="btn sm"
                    class:on={s.openai.baseUrl === p.baseUrl}
                    onclick={() => ((s!.openai.baseUrl = p.baseUrl), (s!.openai.model = p.model))}
                  >
                    {p.name}
                  </button>
                {/each}
              </div>
            </div>
            <label class="field">
              <span>接口地址 Base URL</span><input class="input" bind:value={s.openai.baseUrl} />
            </label>
            <label class="field">
              <span><KeyRound size={13} /> API Key</span>
              <input class="input" type="password" autocomplete="off" bind:value={s.openai.apiKey} />
            </label>
            <div class="field">
              <span>模型</span>
              <div class="inline">
                <input class="input" list="models" aria-label="模型" bind:value={s.openai.model} />
                <button class="btn" onclick={fetchModels}>获取模型列表</button>
              </div>
              <datalist id="models">
                {#each models as m (m)}<option value={m}></option>{/each}
              </datalist>
              {#if modelsMsg}<span class="muted">{modelsMsg}</span>{/if}
            </div>
            <details>
              <summary>高级设置</summary>
              <div class="grid4">
                <label class="field">
                  <span>温度（留空不传）</span>
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
                  <span>每批字符数</span>
                  <input class="input" type="number" min="200" step="100" bind:value={s.openai.maxBatchChars} />
                </label>
                <label class="field">
                  <span>每批段落数</span>
                  <input class="input" type="number" min="1" max="50" bind:value={s.openai.maxBatchItems} />
                </label>
                <label class="field">
                  <span>并发请求数</span>
                  <input class="input" type="number" min="1" max="20" bind:value={s.openai.concurrency} />
                </label>
              </div>
              <label class="field">
                <span>额外提示词（可选：术语表、语气要求等）</span>
                <textarea
                  class="input"
                  rows="3"
                  placeholder="例如：将 agent 统一译为“智能体”；语气自然口语化。"
                  bind:value={s.openai.prompt}></textarea>
              </label>
              <p class="muted">
                使用 Ollama 本地模型时，需要以环境变量 <code>OLLAMA_ORIGINS=chrome-extension://*</code> 启动 Ollama，否则会被跨域拦截。
              </p>
            </details>
          {/if}

          {#if s.provider === 'azure'}
            <p class="muted">
              在 Azure 门户创建 Translator 资源，选择 F0 免费定价层（每月 200 万字符），把“密钥”和“位置/区域”填到下面。
            </p>
            <div class="grid2">
              <label class="field">
                <span><KeyRound size={13} /> 密钥</span>
                <input class="input" type="password" autocomplete="off" bind:value={s.azure.key} />
              </label>
              <label class="field">
                <span>区域（如 eastasia，全局资源可留空）</span><input class="input" bind:value={s.azure.region} />
              </label>
            </div>
          {/if}

          {#if s.provider === 'deepl'}
            <p class="muted">
              在 DeepL 官网注册 API Free 账号获取密钥（Free 密钥以 :fx 结尾，会自动使用免费接口地址）。
            </p>
            <label class="field">
              <span><KeyRound size={13} /> API 密钥</span>
              <input class="input" type="password" autocomplete="off" bind:value={s.deepl.key} />
            </label>
          {/if}

          {#if s.provider === 'google'}
            <p class="muted">无需配置。使用谷歌翻译网页版的免费接口，需要当前网络能访问谷歌。</p>
          {/if}

          <div class="test">
            <button class="btn" onclick={test} disabled={testResult?.ok === null}>
              {#if testResult?.ok === null}<LoaderCircle size={15} class="spin" />{:else}<FlaskConical size={15} />{/if}
              测试当前服务
            </button>
            {#if testResult && testResult.ok !== null}
              <span class="test-result" class:ok={testResult.ok} class:err={!testResult.ok}>{testResult.text}</span>
            {/if}
          </div>
        </div>
      </section>

      <section id="sites" class="card">
        <h2><Globe size={18} /> 总是翻译的网站</h2>
        <label class="field">
          <span>每行一个域名，例如 news.ycombinator.com。打开这些网站时自动翻译。</span>
          <textarea
            class="input"
            rows="4"
            value={s.autoSites.join('\n')}
            onchange={(e) => (s!.autoSites = e.currentTarget.value.split(/\s+/).filter(Boolean))}></textarea>
        </label>
      </section>

      <section id="other" class="card">
        <h2><Database size={18} /> 其他</h2>
        <div class="row">
          <div>
            <div>快捷键</div>
            <div class="muted">
              默认 <kbd>Alt</kbd> + <kbd>A</kbd>，可在 <code>edge://extensions/shortcuts</code> 或
              <code>chrome://extensions/shortcuts</code> 修改
            </div>
          </div>
        </div>
        <div class="row">
          <div>
            <div>翻译缓存</div>
            <div class="muted">已翻译过的段落会缓存在本机，再次访问时秒开。{cacheMsg}</div>
          </div>
          <button class="btn danger" onclick={clearCache}><Trash2 size={15} /> 清空缓存</button>
        </div>
      </section>
    </main>
  </div>
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
