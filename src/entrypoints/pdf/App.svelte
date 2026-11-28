<script lang="ts">
  import { onMount } from 'svelte';
  import { BilingualPdfViewer, type ViewerStatus } from '@/pdf/viewer';
  import { m, setUiLang, uiLocale } from '@/shared/i18n';
  import { sendMessage } from '@/shared/messaging';
  import { getSettings, saveSettings, watchSettings, type PdfMode, type Settings } from '@/shared/settings';
  import CircleAlert from '@lucide/svelte/icons/circle-alert';
  import Download from '@lucide/svelte/icons/download';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import ZoomIn from '@lucide/svelte/icons/zoom-in';
  import ZoomOut from '@lucide/svelte/icons/zoom-out';

  /** 阅读器地址：?file=<编码的地址>，或 declarativeNetRequest 重定向来的 ?DNR:<原样的地址> */
  function sourceUrl(): string | null {
    if (location.search.startsWith('?DNR:')) return location.search.slice(5);
    return new URLSearchParams(location.search).get('file');
  }

  let settings = $state<Settings | null>(null);
  let lang = $state(uiLocale());
  let status = $state<ViewerStatus | null>(null);
  let loaded = $state(false);
  let loading = $state(false);
  let error = $state('');
  /** 导出进度（0–1）；null 表示没有在导出 */
  let exporting = $state<number | null>(null);
  let title = $state('');
  let url = $state(sourceUrl());
  let dragging = $state(false);
  let container: HTMLDivElement;
  let fileInput: HTMLInputElement;
  let viewer: BilingualPdfViewer;

  onMount(() => {
    let stop = () => {};
    void (async () => {
      settings = await getSettings();
      setUiLang(settings.uiLang);
      lang = uiLocale();
      viewer = new BilingualPdfViewer(container, () => settings!);
      viewer.onStatus = (s) => (status = s);
      stop = watchSettings((next) => {
        const prev = settings!;
        settings = next;
        if (setUiLang(next.uiLang)) lang = uiLocale();
        const changed =
          prev.provider !== next.provider ||
          prev.targetLang !== next.targetLang ||
          JSON.stringify(prev.openai) !== JSON.stringify(next.openai) ||
          prev.local.model !== next.local.model ||
          prev.pdf.aiLayout !== next.pdf.aiLayout;
        if (changed) viewer.retranslate();
      });
      if (url) await open({ url }, fileNameOf(url));
    })();
    return () => stop();
  });

  function fileNameOf(u: string): string {
    try {
      return decodeURIComponent(new URL(u).pathname.split('/').pop() || '') || u;
    } catch {
      return u;
    }
  }

  async function open(source: { url: string } | { data: ArrayBuffer }, name: string) {
    error = '';
    loading = true;
    title = name;
    try {
      const doc = await viewer.open(source);
      loaded = true;
      const meta = await doc.getMetadata().catch(() => null);
      const t = (meta?.info as { Title?: string } | undefined)?.Title?.trim();
      if (t) title = t;
      document.title = `${title} · Bilingo`;
    } catch (e) {
      loaded = false;
      error = m.pdf_load_failed({ msg: (e as Error).message || String(e) });
    } finally {
      loading = false;
    }
  }

  async function openFile(file: File | undefined) {
    if (!file) return;
    url = null;
    history.replaceState(null, '', location.pathname);
    await open({ data: await file.arrayBuffer() }, file.name);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    void openFile(file);
  }

  async function setMode(mode: PdfMode) {
    viewer.mode = mode;
    settings = await saveSettings({ pdf: { mode } });
  }

  /** 导出翻译后的 PDF：准备完成后打开打印对话框，选"另存为 PDF" */
  async function exportPdf(layout: 'translation' | 'dual') {
    document.getElementById('download-menu')?.hidePopover();
    exporting = 0;
    try {
      await viewer.exportPdf(layout, (done, total) => (exporting = done / total));
    } catch (e) {
      error = (e as Error).message || String(e);
    } finally {
      exporting = null;
    }
  }

  async function download() {
    document.getElementById('download-menu')?.hidePopover();
    const doc = viewer.document;
    if (!doc) return;
    const data = await doc.getData();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/pdf' }));
    a.download = /\.pdf$/i.test(title) ? title : `${title || 'document'}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  function openNative() {
    if (url) void sendMessage('openPdfNative', { url });
  }

  function goTo(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    viewer.goTo(Number(input.value) || 1);
    input.value = String(status?.page ?? 1);
  }

  const modes: { id: PdfMode; label: () => string }[] = [
    { id: 'dual', label: () => m.pdf_mode_dual() },
    { id: 'translation', label: () => m.pdf_mode_translation() },
    { id: 'original', label: () => m.pdf_mode_original() },
  ];
</script>

<svelte:window
  ondragover={(e: DragEvent) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={(e: DragEvent) => {
    if (!e.relatedTarget) dragging = false;
  }}
  ondrop={onDrop}
/>

<input
  bind:this={fileInput}
  type="file"
  accept="application/pdf,.pdf"
  hidden
  onchange={(e) => openFile(e.currentTarget.files?.[0])}
/>

{#key lang}
  <header class="toolbar">
    <div class="brand">
      <img src="/icon/48.png" alt="" width="22" height="22" />
      <span class="name" {title}>{title || m.pdf_title()}</span>
    </div>

    {#if loaded && status && settings}
      <div class="group">
        <label class="page-nav">
          <span class="sr">{m.pdf_page()}</span>
          <input class="input page-input" value={status.page} onchange={goTo} inputmode="numeric" />
          <span class="muted">{m.pdf_of({ n: status.pages })}</span>
        </label>
        <span class="sep"></span>
        <button
          class="btn ghost icon"
          title={m.pdf_zoom_out()}
          aria-label={m.pdf_zoom_out()}
          onclick={() => viewer.zoomBy(-0.1)}
        >
          <ZoomOut size={17} />
        </button>
        <button class="btn ghost sm zoom" title={m.pdf_zoom_fit()} onclick={() => viewer.setZoom('auto')}>
          {Math.round(status.scale * 100)}%
        </button>
        <button
          class="btn ghost icon"
          title={m.pdf_zoom_in()}
          aria-label={m.pdf_zoom_in()}
          onclick={() => viewer.zoomBy(0.1)}
        >
          <ZoomIn size={17} />
        </button>
      </div>

      <div class="segmented" role="radiogroup" aria-label={m.pdf_mode()}>
        {#each modes as mo (mo.id)}
          <button
            role="radio"
            aria-checked={settings.pdf.mode === mo.id}
            class:on={settings.pdf.mode === mo.id}
            onclick={() => setMode(mo.id)}
          >
            {mo.label()}
          </button>
        {/each}
      </div>

      <div class="status" aria-live="polite">
        {#if exporting !== null}
          <span class="muted">
            <LoaderCircle size={15} class="spin" />
            {m.pdf_exporting({ percent: Math.round(exporting * 100) })}
          </span>
        {:else if settings.pdf.mode === 'original'}
          <!-- 只看原文时不翻译 -->
        {:else if status.layout.state === 'downloading'}
          <span class="muted">
            <LoaderCircle size={15} class="spin" />
            {m.pdf_layout_downloading({ percent: Math.round(status.layout.progress * 100) })}
          </span>
        {:else if error}
          <span class="err" title={error}><CircleAlert size={15} /> {error}</span>
        {:else if status.errors}
          <span class="err" title={status.lastError}>
            <CircleAlert size={15} />
            {m.pdf_failed({ n: status.errors, msg: status.lastError ?? '' })}
          </span>
          <button class="btn sm" onclick={() => viewer.retryFailed()}><RotateCw size={14} /> {m.pdf_retry()}</button>
        {:else if status.loading}
          <span class="muted"><LoaderCircle size={15} class="spin" /> {m.pdf_translating()}</span>
        {:else if status.done}
          <span class="muted">{m.pdf_translated({ n: status.done })}</span>
          {#if status.layout.state === 'ready'}
            <span class="badge accent" title={m.pdf_layout_ready_title({ backend: status.layout.backend })}>
              {m.pdf_layout_badge()}
            </span>
          {:else if status.layout.state === 'error'}
            <span class="badge err" title={status.layout.message}>{m.pdf_layout_failed()}</span>
          {/if}
        {/if}
      </div>
    {/if}

    <div class="group end">
      <button
        class="btn ghost icon"
        title={m.pdf_open_file()}
        aria-label={m.pdf_open_file()}
        onclick={() => fileInput.click()}
      >
        <FolderOpen size={17} />
      </button>
      {#if loaded}
        <button
          class="btn ghost icon"
          title={m.pdf_download()}
          aria-label={m.pdf_download()}
          popovertarget="download-menu"
          style="anchor-name: --download"
          disabled={exporting !== null}
        >
          {#if exporting !== null}<LoaderCircle size={17} class="spin" />{:else}<Download size={17} />{/if}
        </button>
        <div id="download-menu" class="menu card" popover>
          <button onclick={() => exportPdf('translation')}>
            <b>{m.pdf_export_translation()}</b><span class="muted">{m.pdf_export_translation_desc()}</span>
          </button>
          <button onclick={() => exportPdf('dual')}>
            <b>{m.pdf_export_dual()}</b><span class="muted">{m.pdf_export_dual_desc()}</span>
          </button>
          <button onclick={download}>
            <b>{m.pdf_export_original()}</b><span class="muted">{m.pdf_export_original_desc()}</span>
          </button>
          <p class="muted hint">{m.pdf_export_hint()}</p>
        </div>
      {/if}
      {#if url}
        <button
          class="btn ghost icon"
          title={m.pdf_open_native()}
          aria-label={m.pdf_open_native()}
          onclick={openNative}
        >
          <ExternalLink size={17} />
        </button>
      {/if}
      <button
        class="btn ghost icon"
        title={m.settings()}
        aria-label={m.settings()}
        onclick={() => browser.runtime.openOptionsPage()}
      >
        <SettingsIcon size={17} />
      </button>
    </div>
  </header>

  {#if !loaded}
    <div class="empty" class:dragging>
      {#if loading}
        <LoaderCircle size={28} class="spin" />
      {:else}
        <div class="drop card">
          <img src="/icon/128.png" alt="" width="56" height="56" />
          {#if error}
            <p class="err">{error}</p>
          {/if}
          <h1>{m.pdf_drop_hint()}</h1>
          <p class="muted">{m.pdf_drop_note()}</p>
          <button class="btn primary" onclick={() => fileInput.click()}>
            <FolderOpen size={17} />
            {m.pdf_open_file()}
          </button>
        </div>
      {/if}
    </div>
  {/if}
{/key}

<!-- pdf.js 要求容器绝对定位；放在 {#key} 之外，切换界面语言时不会被重建 -->
<div id="viewerContainer" bind:this={container} class:hidden={!loaded}>
  <div id="viewer" class="pdfViewer"></div>
</div>
