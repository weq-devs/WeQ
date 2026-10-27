import type {
  AgentLabEndpoint,
  AgentLabModelCapability,
  AgentLabModelRef,
  AgentLabProviderConfig,
  AgentLabProviderModel,
} from './types';

function trimSlash(value: string): string {
  return value
    .replace(/\/+$/g, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/+$/g, '');
}

function normalizeModel(input: AgentLabProviderModel): AgentLabProviderModel {
  const caps = Array.isArray(input.capabilities) ? input.capabilities : [];
  const capabilities = (['chat', 'embedding', 'vision'] as AgentLabModelCapability[]).filter((c) =>
    caps.includes(c),
  );
  return {
    id: input.id.trim(),
    label: input.label?.trim() || undefined,
    capabilities: Array.isArray(input.capabilities) ? capabilities : ['chat'],
  };
}

export function normalizeProviderConfig(
  input: Omit<AgentLabProviderConfig, 'createdAt' | 'updatedAt'> &
    Partial<Pick<AgentLabProviderConfig, 'createdAt' | 'updatedAt'>>,
): AgentLabProviderConfig {
  const now = Date.now();
  const models = (Array.isArray(input.models) ? input.models : [])
    .map(normalizeModel)
    .filter((m) => m.id);
  return {
    id: input.id.trim(),
    name: input.name.trim(),
    vendor: (input.vendor || 'openai-compatible').trim(),
    baseUrl: trimSlash(input.baseUrl.trim()),
    apiKey: input.apiKey.trim(),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    models,
    createdAt: input.createdAt ?? now,
    updatedAt: now,
  };
}

export function validateProviderConfig(input: AgentLabProviderConfig): void {
  if (
    input.timeoutMs !== undefined &&
    (!Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > 2_147_483_647)
  )
    throw new Error('模型请求期限必须是 1–2147483647 毫秒的整数');
  if (!input.id.trim()) throw new Error('Provider id 不能为空');
  if (!input.name.trim()) throw new Error('Provider 名称不能为空');
  if (!/^https?:\/\//i.test(input.baseUrl)) throw new Error('base_url 必须是 http/https 地址');
  if (!input.apiKey.trim()) throw new Error('api_key 不能为空');
  if (input.models.length === 0) throw new Error('至少配置一个模型');
}

/** provider 里能干某件活（chat/embedding/vision）的模型。 */
export function modelsWithCapability(
  provider: AgentLabProviderConfig,
  capability: AgentLabModelCapability,
): AgentLabProviderModel[] {
  return provider.models.filter((m) => m.capabilities.includes(capability));
}

/** 把 (provider, model) 解析成可直接调用的端点。 */
export function resolveEndpoint(
  provider: AgentLabProviderConfig,
  ref: AgentLabModelRef,
): AgentLabEndpoint {
  return {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: ref.model,
    ...(provider.timeoutMs === undefined ? {} : { timeoutMs: provider.timeoutMs }),
  };
}
