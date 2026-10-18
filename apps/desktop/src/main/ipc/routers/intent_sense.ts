/**
 * `account.intentSense.*` — 意图感知（消息意图/情绪分析 + 对方画像 + 回复建议）
 * 的 tRPC 面。薄壳：配置持久化、分析缓存、引擎选择都在 {@link IntentSenseService}
 * （`@weq/service`）里，这里只做参数校验与 subscription 桥接。
 *
 *   getStatus / setConfig            → 全局配置（总开关、引擎、provider、建议开关）
 *   setConversationOverride          → 单会话开关（null = 跟随全局）
 *   ensureAnalysis                   → 打开会话时增量补分析（后台跑，结果走 onAnalyzed）
 *   getMessageAnalyses               → 批量读缓存（渲染层点亮胶囊）
 *   analyzeMessage                   → 悬停未命中时单条触发
 *   getProfile                       → 对方画像（好感度/MBTI/雷达/话题，仅私聊）
 *   getSuggestions                   → 回复建议（仅 api 引擎 + 建议开关开启）
 *   onAnalyzed                       → 增量分析结果推送
 */

import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import {
  getActiveIntentSenseLocalEngine,
  getAppContext,
  type AccountServices,
  type IntentSenseModelProgress,
} from '../../context/app_context';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

/** 模型下载进度监听（router 模块级单例；下载由设置页触发）。 */
const progressListeners = new Set<(p: IntentSenseModelProgress) => void>();
let downloading = false;

const kindSchema = z.enum(['c2c', 'group']);

const configPatch = z.object({
  enabled: z.boolean().optional(),
  engine: z.enum(['api', 'local']).optional(),
  providerRef: z
    .object({ providerId: z.string().min(1), model: z.string().min(1) })
    .nullable()
    .optional(),
  suggestionsEnabled: z.boolean().optional(),
  hfMirror: z.boolean().optional(),
});

export const intentSenseRouter = router({
  /** 当前配置 + 引擎可用性（apiConfigured / localAvailable）。 */
  getStatus: procedure.query(() => {
    const status = requireServices().intentSense.getStatus();
    if (status.enabled && status.engine === 'local') {
      const engine = getActiveIntentSenseLocalEngine();
      if (engine?.isModelDownloaded()) {
        void engine.start().catch(() => {});
      }
    }
    return status;
  }),

  /** 更新全局配置（缺省字段保持原值）。 */
  setConfig: procedure.input(configPatch).mutation(async ({ input }) => {
    const status = await requireServices().intentSense.setConfig(input);
    if (status.enabled && status.engine === 'local') {
      const engine = getActiveIntentSenseLocalEngine();
      if (engine?.isModelDownloaded()) {
        void engine.start().catch(() => {});
      }
    }
    return status;
  }),

  /** 单会话开关；enabled=null 清除覆盖、恢复跟随全局。 */
  setConversationOverride: procedure
    .input(
      z.object({
        kind: kindSchema,
        id: z.string().min(1),
        enabled: z.boolean().nullable(),
      }),
    )
    .mutation(({ input }) =>
      requireServices().intentSense.setConversationOverride(input.kind, input.id, input.enabled),
    ),

  /** 清空当前账号下所有会话的意图分析缓存与建议缓存。 */
  clearCache: procedure.mutation(() => requireServices().intentSense.clearCache()),

  /**
   * 增量补齐会话分析（打开会话时调用一次；新消息由渲染层再次调用，缓存保证
   * 只补缺口）。批量结果通过 onAnalyzed 增量推送，UI 逐条点亮。
   */
  ensureAnalysis: procedure
    .input(
      z.object({
        kind: kindSchema,
        conv: z.string().min(1),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .mutation(({ input }) =>
      requireServices().intentSense.ensureAnalysis(input.kind, input.conv, input.limit),
    ),

  /** 批量读分析缓存（一次 IPC，页面点亮全部已分析消息）。 */
  getMessageAnalyses: procedure
    .input(
      z.object({ kind: kindSchema, conv: z.string().min(1), msgIds: z.array(z.string()).max(500) }),
    )
    .query(({ input }) =>
      requireServices().intentSense.getMessageAnalyses(input.kind, input.conv, input.msgIds),
    ),

  /** 该会话全部已缓存的分析（打开会话时一次拉齐）。 */
  listMessageAnalyses: procedure
    .input(z.object({ kind: kindSchema, conv: z.string().min(1) }))
    .query(({ input }) =>
      requireServices().intentSense.listMessageAnalyses(input.kind, input.conv),
    ),

  /** 悬停未命中缓存时的单条分析。 */
  analyzeMessage: procedure
    .input(z.object({ kind: kindSchema, conv: z.string().min(1), msgId: z.string().min(1) }))
    .mutation(({ input }) =>
      requireServices().intentSense.analyzeMessage(input.kind, input.conv, input.msgId),
    ),

  /** 对方互动画像（好感度/MBTI/雷达/话题）。仅私聊有语义。 */
  getProfile: procedure
    .input(z.object({ peerUid: z.string().min(1) }))
    .query(({ input }) => requireServices().intentSense.getProfile(input.peerUid)),

  /** 候选回复（api 引擎 + suggestionsEnabled）。 */
  getSuggestions: procedure
    .input(z.object({ kind: kindSchema, conv: z.string().min(1) }))
    .query(({ input }) => requireServices().intentSense.getSuggestions(input.kind, input.conv)),

  /** 增量分析结果推送（ensureAnalysis / analyzeMessage 落缓存后触发）。 */
  onAnalyzed: procedure.subscription(() => {
    return observable<import('@weq/service').IntentAnalyzedEvent>((emit) => {
      const off = requireServices().intentSense.onAnalyzed((event) => emit.next(event));
      return off;
    });
  }),

  // ---- 本地引擎（Laya ONNX，仅桌面版；web 端 control 恒为 null）-----------

  /** 本地引擎与模型状态。 */
  getLocalEngine: procedure.query(() => {
    const engine = getActiveIntentSenseLocalEngine();
    return {
      available: !!engine,
      modelDownloaded: engine?.isModelDownloaded() ?? false,
      engineReady: engine?.ready ?? false,
      modelDir: engine?.modelDir() ?? '',
      downloading,
    };
  }),

  /**
   * 下载/补齐本地模型（幂等：已完整立即完成）。进度走 onModelDownloadProgress。
   * 运行中重复调用直接返回，不打断在途下载。
   */
  downloadLocalModel: procedure
    .input(z.object({ mirror: z.boolean() }))
    .mutation(async ({ input }) => {
      const engine = getActiveIntentSenseLocalEngine();
      if (!engine) return { ok: false, error: '本地引擎仅桌面版可用', alreadyRunning: false };
      if (downloading) return { ok: true, alreadyRunning: true };
      downloading = true;
      const notify = (p: IntentSenseModelProgress): void => {
        for (const cb of progressListeners) {
          try {
            cb(p);
          } catch {
            /* 监听器异常不影响下载 */
          }
        }
      };
      notify({
        filesDone: 0,
        filesTotal: 5,
        received: 0,
        total: 0,
        currentFile: null,
        done: false,
      });
      try {
        await engine.download({ mirror: input.mirror, onProgress: notify });
        return { ok: true, alreadyRunning: false };
      } catch (error) {
        return { ok: false, error: String(error), alreadyRunning: false };
      } finally {
        downloading = false;
      }
    }),

  /** 模型就绪后拉起本地引擎 worker。 */
  startLocalEngine: procedure.mutation(async () => {
    const engine = getActiveIntentSenseLocalEngine();
    if (!engine) return { ok: false, error: '本地引擎仅桌面版可用' };
    try {
      await engine.start();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }),

  stopLocalEngine: procedure.mutation(async () => {
    await getActiveIntentSenseLocalEngine()?.stop();
    return { ok: true };
  }),

  /** 模型下载进度（filesDone/filesTotal/received/total）。 */
  onModelDownloadProgress: procedure.subscription(() => {
    return observable<IntentSenseModelProgress>((emit) => {
      const cb = (p: IntentSenseModelProgress): void => emit.next(p);
      progressListeners.add(cb);
      return () => {
        progressListeners.delete(cb);
      };
    });
  }),
});
