import {
  AGENTLAB_PROVIDER_CATALOG,
  normalizeProviderConfig,
  resolveEndpoint,
  validateProviderConfig,
  type AgentLabEndpoint,
  type AgentLabModelRef,
  type AgentLabProviderCatalogEntry,
  type AgentLabProviderConfig,
} from '@weq/agentlab';
import type { UserConfigService } from './user_config';

export class AgentLabConfigService {
  constructor(private readonly userConfig: UserConfigService) {}

  listProviders(): AgentLabProviderConfig[] {
    return this.userConfig.getSettings().agentLab.providers;
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
