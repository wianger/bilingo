<script lang="ts">
  import { LANGS } from '@/shared/langs';
  import { getSettings, PROVIDERS_META, saveSettings, type ProviderId, type Settings } from '@/shared/settings';
  import { sendToTab } from '@/shared/tabs';
  import { PROVIDER_ICONS } from '@/ui/provider-icons';
  import { providerName, providerTags } from '@/ui/labels';
  import { m, setUiLang, uiLocale } from '@/shared/i18n';
  import Globe from '@lucide/svelte/icons/globe';
  import Languages from '@lucide/svelte/icons/languages';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import Undo2 from '@lucide/svelte/icons/undo-2';
  import SquareDashedMousePointer from '@lucide/svelte/icons/square-dashed-mouse-pointer';
  import { resolveRules } from '@/shared/site-rules';

  let settings = $state<Settings | null>(null);
  let tabId = $state<number>();
  let hostname = $state('');
  let active = $state(false);
  let supported = $state(true);
  let busy = $state(false);
  /** 当前网站生效的网站规则条数 */
  let ruleCount = $state(0);
  /** 界面语言：变化时整个界面重新渲染 */
  let lang = $state(uiLocale());
  const ProviderIcon = $derived(settings ? PROVIDER_ICONS[settings.provider] : null);

  async function init() {
    settings = await getSettings();
    setUiLang(settings.uiLang);
    lang = uiLocale();
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id;
    try {
      const url = new URL(tab?.url ?? '');
      hostname = url.hostname;
      supported = /^(https?|file):$/.test(url.protocol);
      ruleCount = resolveRules(url, settings.siteRules, settings.disabledBuiltinRules).ids.length;
    } catch {
      supported = false;
    }
    if (!supported || tabId === undefined) return;
    try {
      active = (await sendToTab(tabId, 'status')).active;
    } catch {
      supported = false;
    }
  }
  void init();

  async function toggle() {
    if (tabId === undefined || busy) return;
    busy = true;
    try {
      active = (await sendToTab(tabId, 'toggle')).active;
    } catch {
      supported = false;
    } finally {
      busy = false;
    }
  }

  async function change(patch: Partial<Pick<Settings, 'targetLang' | 'provider'>>) {
    settings = await saveSettings(patch);
    if (tabId !== undefined && active) sendToTab(tabId, 'retranslate').catch(() => {});
  }

  /** 在网页上点选区域：交给内容脚本，弹窗随即关闭让出网页 */
  async function pick() {
    if (tabId === undefined) return;
    await sendToTab(tabId, 'startPicker').catch(() => {});
    window.close();
  }

  async function setAlways(on: boolean) {
    if (!settings) return;
    const others = settings.autoSites.filter((h) => h !== hostname);
    settings = await saveSettings({ autoSites: on ? [...others, hostname] : others });
    if (on && !active) await toggle();
  }
</script>

{#if settings}
  {#key lang}
    <main>
      <header>
        <div class="brand">
          <img src="/icon/48.png" alt="" width="26" height="26" />
          <span>Bilingo</span>
        </div>
        <button
          class="btn ghost icon"
          title={m.settings()}
          aria-label={m.settings()}
          onclick={() => browser.runtime.openOptionsPage()}
        >
          <SettingsIcon size={17} />
        </button>
      </header>

      <section class="site card">
        <div class="host">
          <Globe size={14} />
          <span title={hostname}>{hostname || m.popup_this_page()}</span>
          {#if active}<span class="badge accent">{m.popup_translated()}</span>{/if}
        </div>
        <button class="btn main" class:primary={!active} disabled={!supported || busy} onclick={toggle}>
          {#if busy}
            <LoaderCircle size={17} class="spin" />
          {:else if active}
            <Undo2 size={17} />
          {:else}
            <Languages size={17} />
          {/if}
          {active ? m.popup_show_original() : m.popup_translate_page()}
        </button>
        {#if !supported}
          <p class="muted center">{m.popup_unsupported()}</p>
        {:else}
          <div class="pick-row">
            <button class="btn ghost sm" onclick={pick}><SquareDashedMousePointer size={14} /> {m.popup_pick()}</button>
            {#if ruleCount}<span class="muted">{m.popup_rules_active({ n: ruleCount })}</span>{/if}
          </div>
        {/if}
      </section>

      <section class="list card">
        <label class="item">
          <span class="label">{m.target_language()}</span>
          <select
            class="select"
            value={settings.targetLang}
            onchange={(e) => change({ targetLang: e.currentTarget.value })}
          >
            {#each LANGS as l (l.code)}
              <option value={l.code}>{l.name}</option>
            {/each}
          </select>
        </label>
        <label class="item">
          <span class="label">{m.translation_engine()}</span>
          <select
            class="select"
            value={settings.provider}
            onchange={(e) => change({ provider: e.currentTarget.value as ProviderId })}
          >
            <button><selectedcontent></selectedcontent></button>
            {#each Object.keys(PROVIDERS_META) as id (id)}
              {@const Icon = PROVIDER_ICONS[id as ProviderId]}
              <option value={id}><Icon size={15} />{providerName(id as ProviderId)}</option>
            {/each}
          </select>
        </label>
        <label class="item">
          <span class="label">{m.popup_always_translate()}</span>
          <input
            type="checkbox"
            class="switch"
            disabled={!supported}
            checked={settings.autoSites.includes(hostname)}
            onchange={(e) => setAlways(e.currentTarget.checked)}
          />
        </label>
      </section>

      <footer>
        <span class="muted">
          {#if ProviderIcon}<ProviderIcon size={13} />{/if}
          {providerTags(settings.provider)
            .map((t) => t.text)
            .join(' · ')}
        </span>
        <span class="muted"><kbd>Alt</kbd> + <kbd>A</kbd> {m.popup_shortcut_hint()}</span>
      </footer>
    </main>
  {/key}
{/if}

<style>
  main {
    width: 340px;
    padding: 12px;
    display: grid;
    gap: 10px;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 2px 0 4px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 15px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .site {
    display: grid;
    gap: 12px;
    padding: 14px;
  }
  .host {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--muted);
    font-size: 12.5px;
  }
  .host > span:first-of-type {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .host .badge {
    margin-left: auto;
  }
  .main {
    height: 42px;
    font-size: 14px;
    font-weight: 600;
    border-radius: var(--radius);
  }
  .main.primary {
    background: var(--gradient);
    box-shadow: 0 6px 16px -6px oklch(0.55 0.21 280 / 0.55);
  }
  .main.primary:hover:not(:disabled) {
    background: var(--gradient);
    filter: brightness(1.07);
  }
  .pick-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: -4px -6px -6px;
  }
  .pick-row .muted {
    font-size: 11.5px;
  }
  .center {
    text-align: center;
  }
  .list {
    padding: 4px 0;
  }
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 48px;
    padding: 6px 14px;
  }
  .item + .item {
    border-top: 1px solid var(--border);
  }
  .label {
    white-space: nowrap;
  }
  .item .select {
    width: auto;
    max-width: 190px;
    min-height: 32px;
    padding-block: 4px;
    border-color: transparent;
    background-color: var(--surface-2);
  }
  .item .select:hover {
    border-color: var(--border-strong);
  }
  .select :global(selectedcontent),
  .select option {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 4px 2px;
  }
  footer .muted {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
  }
  kbd {
    padding: 1px 5px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: 5px;
    font:
      500 10.5px/1.4 ui-monospace,
      Consolas,
      monospace;
    background: var(--surface);
  }
</style>
