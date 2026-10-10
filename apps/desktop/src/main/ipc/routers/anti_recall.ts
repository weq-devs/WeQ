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

import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
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

export const antiRecallRouter = router({
  /** Current config + live trigger state + whether QQ is running. */
  getStatus: procedure.query(() => {
    return requireServices().antiRecall.getStatus();
  }),

  /** Turn the feature on/off. Installs or drops triggers to match. */
  setEnabled: procedure.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    // Disabling stays allowed: a snapshot imported from a machine that had
    // triggers installed must still be able to drop them.
    if (input.enabled) refuseWhenStatic();
    return requireServices().antiRecall.setEnabled(input.enabled);
  }),

  /**
   * Switch between protecting only the selected conversations and protecting
   * every conversation with no session filter (永久全选).
   */
  setMode: procedure
    .input(z.object({ mode: z.enum(['selected', 'all']) }))
    .mutation(({ input }) => {
      refuseWhenStatic();
      return requireServices().antiRecall.setMode(input.mode);
    }),

  /** Replace the set of conversations protected from recall. */
  setTargets: procedure.input(z.object({ targets: z.array(target) })).mutation(({ input }) => {
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
      }),
    )
    .mutation(({ input }) => {
      return requireServices().antiRecall.setNotify(input);
    }),

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
  listRecallConversations: procedure.query(() => {
    return requireServices().antiRecall.listRecallConversations();
  }),
});
