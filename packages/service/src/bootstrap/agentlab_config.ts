import {
  AGENTLAB_PROVIDER_CATALOG,
  normalizeProviderConfig,
  resolveEndpoint,
  testChatEndpoint,
  validateProviderConfig,
  type AgentLabEndpoint,
  type AgentLabModelRef,
  type AgentLabProviderCatalogEntry,
  type AgentLabProviderConfig,
} from '@weq/agentlab';
import type { UserConfigService } from './user_config';

export class AgentLabConfigService {
  constructor(private readonly userConfig: UserConfigService) {}

  /**
   * 用厂商模板自动补全缺失的模型（仅追加，不覆盖已有）。
   * 解决了用户早前保存的 provider 不包含 catalog 后续新增模型的问题。
   */
  private enrichProvider(p: AgentLabProviderConfig): AgentLabProviderConfig {
    const entry = AGENTLAB_PROVIDER_CATALOG.find((c) => c.vendor === p.vendor);
    if (!entry?.models?.length) return p;
    const existingIds = new Set(p.models.map((m) => m.id));
    const extra = entry.models.filter((m) => !existingIds.has(m.id));
    if (extra.length === 0) return p;
    return { ...p, models: [...p.models, ...extra] };
  }

  listProviders(): AgentLabProviderConfig[] {
    return this.userConfig.getSettings().agentLab.providers.map((p) => this.enrichProvider(p));
  }

  getProvider(providerId: string): AgentLabProviderConfig | null {
    return this.listProviders().find((item) => item.id === providerId) ?? null;
  }

  /** 把 agent 里的「某任务用哪个 provider 的哪个 model」解析成可调用端点。 */
  resolveEndpoint(ref: AgentLabModelRef): AgentLabEndpoint {
    const provider = this.getProvider(ref.providerId);
    if (!provider) throw new Error(`找不到 AgentLab provider: ${ref.providerId}`);
    if (!ref.model?.trim()) throw new Error('未选择模型');
    return resolveEndpoint(provider, ref);
  }

  listCatalog(): AgentLabProviderCatalogEntry[] {
    return AGENTLAB_PROVIDER_CATALOG;
  }

  /**
   * 设置页「测试连通性」：直接用表单里的 base_url / api_key / 某个 chat 模型探活，
   * 不要求先保存。返回 { ok, error?, reply? }，错误里带 HTTP 状态码与响应体（模型/key 一目了然）。
   */
  async testEndpoint(input: { baseUrl: string; apiKey: string; model: string }): Promise<{
    ok: boolean;
    error?: string;
    reply?: string;
  }> {
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl) return { ok: false, error: '请先填写 Base URL。' };
    if (!input.model.trim()) return { ok: false, error: '请先添加并填写一个「聊天」能力的模型。' };
    const endpoint: AgentLabEndpoint = { baseUrl, apiKey: input.apiKey.trim(), model: input.model.trim() };
    return testChatEndpoint(endpoint);
  }

  saveProvider(input: Omit<AgentLabProviderConfig, 'createdAt' | 'updatedAt'>): AgentLabProviderConfig {
    const current = this.listProviders();
    const prev = current.find((item) => item.id === input.id);
    const next = normalizeProviderConfig({
      ...input,
      createdAt: prev?.createdAt,
    });
    validateProviderConfig(next);
    this.userConfig.setSettings({
      agentLab: {
        providers: [
          ...current.filter((item) => item.id !== next.id),
          next,
        ].sort((a, b) => b.updatedAt - a.updatedAt),
      },
    });
    return next;
  }

  deleteProvider(providerId: string): boolean {
    const current = this.listProviders();
    const next = current.filter((item) => item.id !== providerId);
    if (next.length === current.length) return false;
    this.userConfig.setSettings({ agentLab: { providers: next } });
    return true;
  }
}
