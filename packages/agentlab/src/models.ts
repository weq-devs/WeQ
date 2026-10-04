import type { AgentLabModelCapability, AgentLabProviderModel } from './types';

function trimSlash(value: string): string {
  return value.replace(/\/+$/g, '');
}

/**
 * 把用户填的 base_url 变成模型列表端点：已经带 /models 的地址原样返回。
 */
export function resolveModelsEndpoint(baseUrl: string): string {
  const base = trimSlash(baseUrl.trim());
  if (!base) return '';
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

/**
 * 按模型 id 粗略猜能力（embedding / vision / chat），仅用于把拉回来的清单预填进表单。
 * 猜测可能不准，用户在设置页可以随时手动勾选修正。
 */
export function inferCapabilities(id: string): AgentLabModelCapability[] {
  const lower = id.toLowerCase();
  if (/embed/.test(lower)) return ['embedding'];
  const caps: AgentLabModelCapability[] = ['chat'];
  if (/(^|[^a-z])(vl|vision|omni|4o|4\.1|4v)([^a-z]|$)/.test(lower)) caps.push('vision');
  return caps;
}

interface RawModelItem {
  id?: unknown;
  name?: unknown;
  model?: unknown;
}

/**
 * 从模型列表响应里抽出条目，兼容 OpenAI 风格 / {models:[]} / 裸数组三种形状。
 */
export function parseModelList(data: unknown): AgentLabProviderModel[] {
  let raw: RawModelItem[] = [];
  if (Array.isArray(data)) raw = data as RawModelItem[];
  else if (data && typeof data === 'object') {
    const holder = data as { data?: unknown; models?: unknown };
    if (Array.isArray(holder.data)) raw = holder.data as RawModelItem[];
    else if (Array.isArray(holder.models)) raw = holder.models as RawModelItem[];
  }

  const seen = new Set<string>();
  const models: AgentLabProviderModel[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const idRaw = item.id ?? item.model ?? item.name;
    if (typeof idRaw !== 'string') continue;
    const id = idRaw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const labelRaw = typeof item.name === 'string' ? item.name.trim() : '';
    models.push({
      id,
      label: labelRaw && labelRaw !== id ? labelRaw : undefined,
      capabilities: inferCapabilities(id),
    });
  }
  return models;
}

/**
 * 按填入的 base_url (+ api_key) 拉取厂商可用模型列表（参考 MaiBot 的 /models 代理）。
 * 走 OpenAI 兼容的 GET {baseUrl}/models，Bearer 鉴权；apiKey 为空时不带鉴权头。
 */
export async function fetchProviderModels(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
}): Promise<AgentLabProviderModel[]> {
  const url = resolveModelsEndpoint(input.baseUrl);
  if (!url) throw new Error('Base URL 不能为空');

  const headers: Record<string, string> = { accept: 'application/json' };
  const apiKey = input.apiKey?.trim();
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 15_000);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).trim().slice(0, 300);
      throw new Error(`接口返回 HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
    }
    const data: unknown = await res.json();
    return parseModelList(data);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('请求超时，请检查网络或 Base URL');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
