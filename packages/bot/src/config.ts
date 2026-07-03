/**
 * 导出的 bot 服务运行时配置（对应产物根目录的 config.json）。
 *
 * 设计原则：**声明式 + 扩展友好**。config.json 由桌面「导出好友」生成，用户只需填 napcat/snowluma
 * 的 ws 地址与 token 即可启动。未来扩展（更多 provider 能力 / 功能开关）只往这里加字段，不改结构。
 */
import type { AgentLabModelRef, AgentLabEndpoint, EndpointResolver, TtsProviderConfig } from '@weq/agentlab';

export type AdapterType = 'napcat' | 'snowluma';

/** OneBot 反向？——本期只做正向：bot 作为 ws 客户端连 napcat/snowluma 的 ws 服务。 */
export interface AdapterConfig {
  type: AdapterType;
  /** napcat/snowluma 的正向 ws 地址，如 ws://127.0.0.1:8081 */
  wsUrl: string;
  /** 鉴权 token（走 Authorization: Bearer；留空则不带鉴权头）。 */
  token?: string;
  /** 断线重连间隔（毫秒，默认 3000）。 */
  reconnectDelayMs?: number;
  /** 单次 action RPC 的超时（毫秒，默认 15000）。 */
  actionTimeoutMs?: number;
}

/** LLM provider（导出时从桌面 AppSettings.agentLab 抽出）。persona.models 的 ref.providerId 指向这些。 */
export interface BotLlmProvider {
  id: string;
  baseUrl: string;
  apiKey: string;
}

/** 功能开关（扩展预留：随能力增长往这里加，默认关）。 */
export interface BotFeatures {
  /** 允许克隆体发语音（需 ttsProviders 就绪，M2）。 */
  voice?: boolean;
  /** 参与群聊（意愿闸决定是否回，M3）。 */
  groupChat?: boolean;
}

/** 本机 WebUI 控制台（统计 / 总览；导出时生成密钥+编号）。 */
export interface WebUiConfig {
  /** 是否启用（默认启用；关掉则 bot 不开端口）。 */
  enabled?: boolean;
  /** 监听端口（仅 127.0.0.1，默认 8090）。 */
  port?: number;
  /** 访问密钥（导出时随机生成的 hex）。 */
  key: string;
  /** bot 编号（导出时随机生成的 uuid，用于识别产物）。 */
  id: string;
}

export interface BotConfig {
  adapter: AdapterConfig;
  /** bot 自己的 QQ 号（= AgentRuntime.selfId；用于区分「自己发的」消息）。 */
  selfId: string;
  /** persona 资产根目录（含 persona.json + stickers/ + voice/ + agentvoice/）。相对 config 或绝对路径。 */
  personaDir: string;
  /** LLM providers（persona.models 的 ref 指向）。 */
  llmProviders: BotLlmProvider[];
  /** TTS providers（导出自 AppSettings.voiceTranscribe.ttsProviders；persona.voice.providerId 指向）。 */
  ttsProviders?: TtsProviderConfig[];
  features?: BotFeatures;
  /** 本机 WebUI 控制台配置（缺省则不启）。 */
  webui?: WebUiConfig;
}

/**
 * 从 config 的 LLM providers 构造 AgentRuntime 需要的 EndpointResolver：
 * persona.models 里的 { providerId, model } 引用 → 可直接 fetch 的 { baseUrl, apiKey, model }。
 */
export function buildEndpointResolver(providers: BotLlmProvider[]): EndpointResolver {
  const byId = new Map(providers.map((p) => [p.id, p]));
  return (ref: AgentLabModelRef): AgentLabEndpoint => {
    const p = byId.get(ref.providerId);
    if (!p) throw new Error(`未配置 LLM provider: ${ref.providerId}（persona 引用了它但 config.llmProviders 里没有）`);
    return { baseUrl: p.baseUrl, apiKey: p.apiKey, model: ref.model };
  };
}
