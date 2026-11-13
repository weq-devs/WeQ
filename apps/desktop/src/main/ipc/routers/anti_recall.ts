/**
 * `account.antiRecall.*` — the anti-recall settings surface.
 *
 * Thin tRPC skin over {@link AntiRecallService} (see `@weq/service`): the config
 * persistence + SQL-trigger install/drop all live there. The renderer's
 * 「更多 → 防撤回」面板与「会话设置」弹窗驱动它：
 *   getStatus    → { enabled, mode, targets, notifyEnabled, notifyTargets, installed, qqRunning }
 *   setEnabled   → flip master switch, (re)install or drop triggers
 *   setMode      → 'selected' | 'all'，重建触发器
 *   setTargets   → replace the protected-conversation set, reconcile triggers
 *   setNotify    → 通知总开关 + 按会话通知集
 *   listRecalls  → 某个会话已记录的撤回（撤回记录面板）
 *   listRecallConversations → 有撤回记录的会话目录（撤回记录集成页）
 *
 * Settings writes are optimistic: they persist + return immediately and the
 * (SQLCipher) trigger reconcile runs in the background, so the UI never blocks.
 * `setEnabled` / `setTargets` install or drop the triggers whether or not QQ is
 * running; if QQ is open it may keep serving from its cached schema until the
 * next restart, so `getStatus().qqRunning` lets the UI warn about that.
 */
import { OperationError } from '@weq/service';

import { z } from 'zod';
import { getAppContext, requireBootstrap, type AccountServices } from '../../context/app_context';
import type { AntiRecallStatus } from '@weq/service';
import { procedure, router } from '../trpc';
import { assertAccountBinding, optionalAccountBinding } from '../account_binding';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new OperationError(
      'No account session open — call bootstrap.openAccount first.',
      'expected',
    );
  }
  return ctx.services;
}

/**
 * Anti-recall only means something against databases a live QQ (or a writable
 * Android backup) writes to. A PC-snapshot static account's databases are a
 * dead read-only copy, so refuse rather than write dead SQL the user believes
 * is protecting them. Android backup accounts (accountIsAndroidBackup) are
 * writable, so they are allowed through.
 */
function refuseWhenStatic(): void {
  const ctx = getAppContext();
  if (ctx.accountIsStatic && !ctx.accountIsAndroidBackup) {
    throw new Error('静态账号的数据库是离线快照，QQ 不会写入，防撤回无法生效。');
  }
}

const target = z.object({
  kind: z.enum(['c2c', 'group', 'dataline']),
  id: z.string().min(1),
});

export async function sharedAntiRecallStatus(): Promise<AntiRecallStatus> {
  const service = getAppContext().services?.antiRecall;
  if (service) return service.getStatus();
  const value = requireBootstrap().userConfig.getSharedPreference('antiRecall');
  return {
    settingsRevision: requireBootstrap().userConfig.sharedPreferenceRevision(),
    enabled: value.enabled ?? false,
    mode: value.mode ?? 'selected',
    notifyEnabled: value.notifyEnabled ?? false,
    targets: [],
    notifyTargets: [],
    installed: [],
    qqRunning: false,
  };
}

export const antiRecallSettingsProcedures = {
  /** Current config + live trigger state + whether QQ is running. */
  getStatus: procedure.query(() => {
    return sharedAntiRecallStatus();
  }),

  /** Turn the feature on/off. Installs or drops triggers to match. */
  setEnabled: procedure.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    // Disabling stays allowed: a snapshot imported from a machine that had
    // triggers installed must still be able to drop them.
    if (getAppContext().services) return requireServices().antiRecall.setEnabled(input.enabled);
    requireBootstrap().userConfig.patchSharedPreference('antiRecall', { enabled: input.enabled });
    return sharedAntiRecallStatus();
  }),

  /**
   * 设置「启用范围」：关闭 / 按会话勾选 / 永久全选。
   * 关闭时只卸触发器，不拒绝静态账号（导入的旧快照也要能清掉）。
   */
  setScope: procedure
    .input(z.object({ scope: z.enum(['off', 'selected', 'all']) }))
    .mutation(({ input }) => {
      if (getAppContext().services) return requireServices().antiRecall.setScope(input.scope);
      requireBootstrap().userConfig.patchSharedPreference('antiRecall', {
        enabled: input.scope !== 'off',
        mode: input.scope === 'all' ? 'all' : 'selected',
      });
      return sharedAntiRecallStatus();
    }),

  /**
   * Switch between protecting only the selected conversations and protecting
   * every conversation with no session filter (永久全选).
   */
  setMode: procedure
    .input(z.object({ mode: z.enum(['selected', 'all']) }))
    .mutation(({ input }) => {
      if (getAppContext().services) return requireServices().antiRecall.setMode(input.mode);
      requireBootstrap().userConfig.patchSharedPreference('antiRecall', { mode: input.mode });
      return sharedAntiRecallStatus();
    }),

  /** Replace the set of conversations protected from recall. */
  setTargets: procedure
    .input(z.object({ targets: z.array(target), ...optionalAccountBinding }))
    .mutation(({ input }) => {
      assertAccountBinding(input);
      refuseWhenStatic();
      return requireServices().antiRecall.setTargets(input.targets);
    }),

  /**
   * 撤回通知：总开关 + 按会话通知集（key `${kind}:${id}`）。不改触发器，纯配置。
   */
  setNotify: procedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        targets: z.array(z.string()).optional(),
        ...optionalAccountBinding,
      }),
    )
    .mutation(({ input }) => {
      if (input.targets) assertAccountBinding(input);
      if (getAppContext().services) return requireServices().antiRecall.setNotify(input);
      if (input.targets) throw new Error('请先打开账号再选择通知会话');
      if (input.enabled !== undefined)
        requireBootstrap().userConfig.patchSharedPreference('antiRecall', {
          notifyEnabled: input.enabled,
        });
      return sharedAntiRecallStatus();
    }),
};

export const antiRecallRouter = router({
  ...antiRecallSettingsProcedures,

  /**
   * 某个会话已记录的撤回（最新在前）—— 撤回记录面板用。只读，不依赖 QQ 在线。
   */
  listRecalls: procedure
    .input(z.object({ kind: z.enum(['c2c', 'group']), conv: z.string().min(1) }))
    .query(({ input }) => {
      return requireServices().antiRecall.listRecalls(input.kind, input.conv);
    }),

  /**
   * 有撤回记录的会话目录（计数 + 最近一次撤回时间，最新活动在前）——「更多 →
   * 防撤回」里那一页按会话浏览撤回记录的入口。只读本地记录表，不依赖 QQ 在线。
   */
  listRecallConversations: procedure.query(async () => {
    const { antiRecall, gapHistory } = requireServices();
    const summaries = await antiRecall.listRecallConversations();
    const byConv = new Map(summaries.map((row) => [`${row.kind}:${row.conv}`, { ...row }]));
    const knownSeqs = new Map<string, Set<string>>();
    for (const message of await gapHistory.cachedRecalls()) {
      const key = `${message.kind}:${message.conv}`;
      let seqs = knownSeqs.get(key);
      if (!seqs) {
        seqs = new Set(
          (await antiRecall.listRecalls(message.kind, message.conv)).map((row) => row.origSeq),
        );
        knownSeqs.set(key, seqs);
      }
      if (seqs.has(message.msgSeq)) continue;
      seqs.add(message.msgSeq);
      const summary = byConv.get(key) ?? {
        kind: message.kind,
        conv: message.conv,
        count: 0,
        lastTs: 0,
      };
      summary.count++;
      summary.lastTs = Math.max(summary.lastTs, message.recall?.recallTs ?? 0);
      byConv.set(key, summary);
    }
    return [...byConv.values()].sort((a, b) => b.lastTs - a.lastTs);
  }),
});
