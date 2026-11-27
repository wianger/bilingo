// 各翻译服务的图标（Lucide，按需引入）
import type { Component } from 'svelte';
import Bot from '@lucide/svelte/icons/bot';
import Cloud from '@lucide/svelte/icons/cloud';
import Cpu from '@lucide/svelte/icons/cpu';
import Feather from '@lucide/svelte/icons/feather';
import Globe from '@lucide/svelte/icons/globe';
import Monitor from '@lucide/svelte/icons/monitor';
import type { ProviderId } from '@/shared/settings';

export const PROVIDER_ICONS: Record<ProviderId, Component> = {
  builtin: Monitor,
  local: Cpu,
  google: Globe,
  azure: Cloud,
  deepl: Feather,
  openai: Bot,
};
