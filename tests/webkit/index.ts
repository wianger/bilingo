// 相当于 Safari 版扩展的后台页面：用隐藏 iframe 托管模型，直接调用其接口（与 src/background/providers/local.ts 相同的路径）
import { frameApi } from '@/local-llm/frame';
import { findPreset, formatOf } from '@/local-llm/models';
import type { LocalModelConfig } from '@/local-llm/protocol';

declare global {
  interface Window {
    probe(): Promise<Record<string, unknown>>;
    translate(model: string, host: string, texts: string[]): Promise<{ result: string[]; ms: number; status: unknown }>;
  }
}

window.probe = async () => {
  const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
  const out: Record<string, unknown> = { userAgent: navigator.userAgent, hasGpu: !!gpu };
  if (!gpu) return out;
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  out.adapter = adapter
    ? {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        description: adapter.info.description,
        shaderF16: adapter.features.has('shader-f16'),
        maxBufferSize: adapter.limits.maxBufferSize,
      }
    : null;
  return out;
};

window.translate = async (model, host, texts) => {
  const config: LocalModelConfig = {
    model,
    host,
    format: formatOf(model),
    dtype: findPreset(model)?.dtype,
    locale: 'en',
  };
  const api = await frameApi('/llm.html');
  const t0 = performance.now();
  const result = await api.translate(config, texts, 'zh-CN');
  return { result, ms: Math.round(performance.now() - t0), status: api.status() };
};
