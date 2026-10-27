import {
  AGENTLAB_PROVIDER_CATALOG,
  fetchProviderModels,
  normalizeProviderConfig,
  resolveEndpoint,
  testChatEndpoint,
  detectModelCapabilities,
  validateProviderConfig,
  isDefaultModelSelection,
  modelEndpointIdentity,
  type AgentLabEndpoint,
  type AgentLabModelRef,
  type AgentLabModelSelection,
  type AgentLabModels,
  type AgentLabModelCapability,
  type AgentLabProviderCatalogEntry,
  type AgentLabProviderConfig,
  type AgentLabProviderModel,
  type TtsProviderConfig,
} from '@weq/agentlab';
import type { UserConfigService } from './user_config';

export class AgentLabConfigService {
  constructor(
    private readonly userConfig: UserConfigService,
    private readonly onUsage?: AgentLabEndpoint['onUsage'],
  ) {}

  /**
   * 已保存的 provider 原样返回，不做任何补全。
   * 曾经这里会用厂商模板自动补全缺失的推荐模型，导致用户在设置页删掉的模型
   * 一保存就被「复活」，怎么改都保存不上；需要模板推荐时由设置页的
   * 「导入模板推荐」按钮显式导入（不覆盖、不复活用户已删的内容）。
   */
  listProviders(): AgentLabProviderConfig[] {
    return this.userConfig.getSettings().agentLab.providers;
  }

  getProvider(providerId: string): AgentLabProviderConfig | null {
    return this.listProviders().find((item) => item.id === providerId) ?? null;
  }

  getDefaultModel(): AgentLabModelRef | null {
    return this.userConfig.getSettings().agentLab.defaultModel;
  }

  getDefaultModelStatus() {
    const ref = this.getDefaultModel();
    if (!ref) return { ref: null, available: false, error: null };
    try {
      this.resolveDefaultEndpoint(ref);
      return { ref, available: true, error: null };
    } catch (error) {
      return {
        ref,
        available: false,
        error: error instanceof Error ? error.message : '默认模型不可用',
      };
    }
  }

  setDefaultModel(ref: AgentLabModelRef | null) {
    const next = ref ? { providerId: ref.providerId.trim(), model: ref.model.trim() } : null;
    if (next && (next.providerId.includes('\0') || next.model.includes('\0')))
      throw new Error('默认模型引用无效');
    if (next) this.resolveDefaultEndpoint(next);
    this.userConfig.setSettings({ agentLab: { defaultModel: next } });
    return this.getDefaultModelStatus();
  }

  resolveDefaultEndpoint(
    ref = this.getDefaultModel(),
    capability: AgentLabModelCapability = 'chat',
  ): AgentLabEndpoint {
    if (!ref) throw new Error('未设置默认模型');
    const provider = this.getProvider(ref.providerId);
    if (!provider) throw new Error(`默认模型的 provider 不可用：${ref.providerId}`);
    const model = provider.models.find(
      (item) =>
        item.id === ref.model &&
        item.capabilities?.includes('chat') !== false &&
        item.capabilities?.includes(capability) !== false,
    );
    if (!model) throw new Error(`默认模型不存在或不支持 ${capability}：${ref.model}`);
    validateProviderConfig(provider);
    return this.resolveEndpoint(ref);
  }

  /** 按 id 取 TTS provider 配置（供导出 bot 打包语音配置）。 */
  getTtsProvider(providerId: string): TtsProviderConfig | null {
    return (
      this.userConfig.getSettings().voiceTranscribe.ttsProviders.find((p) => p.id === providerId) ??
      null
    );
  }

  /** 把 agent 里的「某任务用哪个 provider 的哪个 model」解析成可调用端点。 */
  resolveModelRef(
    ref: AgentLabModelSelection,
    capability: AgentLabModelCapability = 'chat',
  ): AgentLabModelRef {
    if (!isDefaultModelSelection(ref)) return { ...ref };
    const current = this.getDefaultModel();
    this.resolveDefaultEndpoint(current, capability);
    if (!current) throw new Error('未设置默认模型');
    return { ...current };
  }

  resolveModels(models: AgentLabModels) {
    return {
      chat: this.resolveModelRef(models.chat),
      ...(models.embedding
        ? { embedding: this.resolveModelRef(models.embedding, 'embedding') }
        : {}),
      ...(models.vision ? { vision: this.resolveModelRef(models.vision, 'vision') } : {}),
      ...(models.voiceClone ? { voiceClone: this.resolveModelRef(models.voiceClone) } : {}),
    };
  }

  resolveEndpoint(
    ref: AgentLabModelSelection,
    capability: AgentLabModelCapability = 'chat',
  ): AgentLabEndpoint {
    if (isDefaultModelSelection(ref)) return this.resolveDefaultEndpoint(undefined, capability);
    const provider = this.getProvider(ref.providerId);
    if (!provider) throw new Error(`找不到 AgentLab provider: ${ref.providerId}`);
    if (!ref.model?.trim()) throw new Error('未选择模型');
    return {
      ...resolveEndpoint(provider, ref),
      modelIdentity: modelEndpointIdentity(ref, provider.baseUrl),
    };
  }

  listCatalog(): AgentLabProviderCatalogEntry[] {
    return AGENTLAB_PROVIDER_CATALOG;
  }

  /**
   * 按填入的 base_url (+ api_key) 拉取厂商可用模型列表（参考 MaiBot 的 /models 代理）。
   * 不要求先保存 provider：直接拿表单里的值请求，方便「边填边拉」。
   */
  async fetchModels(input: { baseUrl: string; apiKey?: string }): Promise<AgentLabProviderModel[]> {
    const baseUrl = input.baseUrl.trim();
    if (!baseUrl) throw new Error('请先填写 Base URL。');
    return fetchProviderModels({ baseUrl, apiKey: input.apiKey });
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
    const endpoint: AgentLabEndpoint = {
      baseUrl,
      apiKey: input.apiKey.trim(),
      model: input.model.trim(),
      feature: 'connection-test',
      onUsage: this.onUsage,
    };
    return testChatEndpoint(endpoint);
  }

  async detectCapabilities(input: { baseUrl: string; apiKey: string; model: string }) {
    const baseUrl = input.baseUrl
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/chat\/completions$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('请填写有效的 Base URL。');
    if (!input.model.trim()) throw new Error('请先填写模型 ID。');
    return detectModelCapabilities({
      baseUrl,
      apiKey: input.apiKey.trim(),
      model: input.model.trim(),
      onUsage: this.onUsage,
    });
  }

  saveProvider(
    input: Omit<AgentLabProviderConfig, 'createdAt' | 'updatedAt'>,
  ): AgentLabProviderConfig {
    const current = this.listProviders();
    const prev = current.find((item) => item.id === input.id);
    const next = normalizeProviderConfig({
      ...input,
      timeoutMs: input.timeoutMs ?? prev?.timeoutMs,
      createdAt: prev?.createdAt,
    });
    validateProviderConfig(next);
    this.userConfig.setSettings({
      agentLab: {
        providers: [...current.filter((item) => item.id !== next.id), next].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        ),
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
