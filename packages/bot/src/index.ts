/**
 * @weq/bot 入口：把一个导出的克隆体跑成 OneBot bot。
 *
 * startBot(config, opts) 组装 AgentLabStore(persona) + AgentRuntime(引擎) + Adapter(napcat/snowluma) +
 * Orchestrator(编排) + WebUI，连上 ws 即上线。产物的 index.mjs 读 config.json 后调用它。
 *
 * 完全重载：WebUI 的 POST /api/reload → 走 opts.reloadConfig() 重读 config.json → 停掉当前实例
 * （断 ws、关 WebUI）→ 用新配置重新 boot()。同进程内等价于一次干净重启，连接/编排/统计全部重建，
 * 不需要用户手动 npm start。stats 落盘在 data/stats.json，重载后自动续上。
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
  JsonRelationStore,
} from './stores';
import { StatsStore } from './stats';
import { startWebUi, type WebUiHandle } from './webui/server';

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

/** 一次组装好的运行实例（可整体 stop，供重载时替换）。 */
interface BotInstance {
  stop: () => void;
}

export interface StartBotOptions {
  /**
   * 重载时重新获取配置（通常是重读 config.json 并把 personaDir 补成绝对路径）。
   * 缺省则重载会复用首次传入的 config（只重建对象，不重读文件）。
   */
  reloadConfig?: () => BotConfig | Promise<BotConfig>;
}

/** 组装一个完整实例：store + runtime + adapter + orchestrator + WebUI，连上即上线。 */
async function boot(
  config: BotConfig,
  onReload: () => Promise<{ ok: boolean; message?: string }>,
): Promise<BotInstance> {
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

  // 记忆 / 关系 / 对话历史 / 统计落盘到产物 data/ 目录（personaDir 的同级），**重启保持**。
  const dataDir = join(config.personaDir, '..', 'data');
  const stats = new StatsStore(join(dataDir, 'stats.json'));
  const runtime = new AgentRuntime({
    rootDir: config.personaDir,
    store,
    endpoints: buildEndpointResolver(config.llmProviders),
    usage: stats,
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
    stats,
  });
  orchestrator.start();

  // 本机 WebUI 控制台（默认开；仅 127.0.0.1，用导出时生成的密钥鉴权）。
  let webui: WebUiHandle | null = null;
  if (config.webui && config.webui.enabled !== false && config.webui.key) {
    webui = await startWebUi({
      port: config.webui.port ?? 8090,
      key: config.webui.key,
      id: config.webui.id,
      persona,
      stats,
      features: { voice: config.features?.voice ?? false, groupChat: config.features?.groupChat ?? false },
      ttsProviders: config.ttsProviders,
      onReload,
      logger: consoleLogger,
    });
  }

  await adapter.connect();
  consoleLogger.info(`已连接 ${config.adapter.type} @ ${config.adapter.wsUrl}，克隆体「${persona.name}」上线`);

  return {
    stop: () => {
      adapter.close();
      webui?.close();
    },
  };
}

export async function startBot(config: BotConfig, opts: StartBotOptions = {}): Promise<{ stop: () => void }> {
  let current: BotInstance | null = null;
  let reloading = false;

  // 完全重载：停当前实例 → 重读配置 → 重新 boot。任一步失败则保底不留半死实例。
  async function reload(): Promise<{ ok: boolean; message?: string }> {
    if (reloading) return { ok: false, message: '正在重载中，请稍候' };
    reloading = true;
    try {
      consoleLogger.info('收到重载请求，正在重启实例…');
      current?.stop();
      current = null;
      // 关端口/断连需要一点时间落地，稍等避免 EADDRINUSE / ws 抢占。
      await new Promise((r) => setTimeout(r, 300));
      const nextConfig = opts.reloadConfig ? await opts.reloadConfig() : config;
      current = await boot(nextConfig, reload);
      consoleLogger.info('重载完成，实例已用新配置上线。');
      return { ok: true, message: '已按新配置完全重载' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      consoleLogger.error(`重载失败：${message}`);
      return { ok: false, message };
    } finally {
      reloading = false;
    }
  }

  current = await boot(config, reload);
  return { stop: () => current?.stop() };
}

export { buildEndpointResolver } from './config';
export type { BotConfig, AdapterConfig, AdapterType, BotLlmProvider, BotFeatures, WebUiConfig } from './config';
export { StatsStore } from './stats';
export { startWebUi, type WebUiHandle } from './webui/server';
export { createAdapter, NapcatAdapter, SnowLumaAdapter, BaseOneBotAdapter } from './adapter/onebot';
export type { OneBot11Adapter, OneBotSegment, IncomingEvent, SendTarget } from './adapter/types';
export { BotOrchestrator } from './orchestrator';
export { BotCapabilities } from './capabilities';
export { normalizeInbound, type NormalizedMessage } from './normalize/inbound';
export { encodeTurn, type AssetResolver } from './normalize/outbound';
