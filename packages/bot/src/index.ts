/**
 * @weq/bot 入口：把一个导出的克隆体跑成 OneBot bot。
 *
 * startBot(config) 组装 AgentLabStore(persona) + AgentRuntime(引擎) + Adapter(napcat/snowluma) +
 * Orchestrator(编排)，连上 ws 即上线。产物的 index.mjs 读 config.json 后调用它。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  AgentLabStore,
  AgentRuntime,
  TtsService,
  type RuntimeLogger,
  type TtsPort,
  type TtsProviderConfig,
} from '@weq/agentlab';
import { buildEndpointResolver, type BotConfig } from './config';
import { createAdapter } from './adapter/onebot';
import type { AssetResolver } from './normalize/outbound';
import { BotOrchestrator } from './orchestrator';
import {
  JsonConversationStore,
  JsonMemoryStore,
  JsonNotesStore,
  NoopUsageStore,
  JsonRelationStore,
} from './stores';

const consoleLogger: RuntimeLogger = {
  child: () => consoleLogger,
  info: (msg, ctx) => console.log(`[bot] ${msg}`, ctx ?? ''),
  warn: (msg, ctx) => console.warn(`[bot] ${msg}`, ctx ?? ''),
  error: (msg, ctx) => console.error(`[bot] ${msg}`, ctx ?? ''),
};

/**
 * 从 config 的 ttsProviders 构造 TtsPort（复用下沉到 @weq/agentlab 的 TtsService，纯 fetch）。
 * 门控：只有开了 features.voice 且配了 provider 才启用；否则返回 undefined（克隆体降级纯文字）。
 */
function buildTtsPort(config: BotConfig): TtsPort | undefined {
  const providers = config.ttsProviders ?? [];
  if (!config.features?.voice || providers.length === 0) return undefined;
  const service = new TtsService();
  const byId = new Map<string, TtsProviderConfig>(providers.map((p) => [p.id, p]));
  return {
    getCapabilities: (id) => {
      const p = byId.get(id);
      return p ? service.capabilities(p.vendor) : null;
    },
    synthesize: (id, text, opts) => {
      const p = byId.get(id);
      if (!p) throw new Error(`TTS provider 不存在: ${id}`);
      return service.synthesize(p, text, opts);
    },
  };
}

export async function startBot(config: BotConfig): Promise<{ stop: () => void }> {
  const store = new AgentLabStore(config.personaDir);
  const persona = store.listPersonas()[0];
  if (!persona) throw new Error(`personaDir 里没有克隆体数据: ${config.personaDir}`);

  // 导出产物里语音参考 refClips[].path 是相对 personaDir 的（如 voice/x.wav）——补成绝对并回写一次，
  // 这样 AgentRuntime 内部 store.getPersona 拿到的路径可直接读到 wav。
  const refClips = persona.voiceProfile?.refClips ?? [];
  let patched = false;
  for (const clip of refClips) {
    if (clip.path && !isAbsolute(clip.path)) {
      clip.path = join(config.personaDir, clip.path);
      patched = true;
    }
  }
  if (patched) {
    const rec = store.getPersona(persona.id);
    if (rec) store.savePersona({ persona, pairs: rec.pairs });
  }

  // 记忆 / 关系 / 对话历史落盘到产物 data/ 目录（personaDir 的同级），**重启保持**。
  const dataDir = join(config.personaDir, '..', 'data');
  const runtime = new AgentRuntime({
    rootDir: config.personaDir,
    store,
    endpoints: buildEndpointResolver(config.llmProviders),
    usage: new NoopUsageStore(),
    conversations: new JsonConversationStore(join(dataDir, 'conversations.json')),
    memories: new JsonMemoryStore(join(dataDir, 'memories.json')),
    notes: new JsonNotesStore(join(dataDir, 'notes.json')),
    relations: new JsonRelationStore(join(dataDir, 'relations.json')),
    selfId: config.selfId,
    tts: buildTtsPort(config),
    logger: consoleLogger,
  });

  const assets: AssetResolver = {
    stickerPath: (md5) => {
      const p = join(config.personaDir, 'stickers', `${md5}.png`);
      return existsSync(p) ? p : null;
    },
    voicePath: (id) => runtime.getAgentVoicePath(id),
  };

  const adapter = createAdapter(config.adapter);
  const orchestrator = new BotOrchestrator(adapter, runtime, persona.id, config.selfId, assets, {
    groupChat: config.features?.groupChat ?? false,
  });
  orchestrator.start();
  await adapter.connect();
  consoleLogger.info(`已连接 ${config.adapter.type} @ ${config.adapter.wsUrl}，克隆体「${persona.name}」上线`);

  return { stop: () => adapter.close() };
}

export { buildEndpointResolver } from './config';
export type { BotConfig, AdapterConfig, AdapterType, BotLlmProvider, BotFeatures } from './config';
export { createAdapter, NapcatAdapter, SnowLumaAdapter, BaseOneBotAdapter } from './adapter/onebot';
export type { OneBot11Adapter, OneBotSegment, IncomingEvent, SendTarget } from './adapter/types';
export { BotOrchestrator } from './orchestrator';
export { BotCapabilities } from './capabilities';
export { normalizeInbound, type NormalizedMessage } from './normalize/inbound';
export { encodeTurn, type AssetResolver } from './normalize/outbound';
