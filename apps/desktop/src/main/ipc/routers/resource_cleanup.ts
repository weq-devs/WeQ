/**
 * `account.resourceCleanup.*` — the 本地资源整理 → 清理释放 backend.
 *
 * Thin tRPC skin over `ResourceCleanupService` (see `@weq/service`): list the
 * deletable nt_data resource trees with their on-disk sizes, and execute a batch
 * of cleanup instructions. All whitelist / containment safety lives in the
 * service — this layer only shapes input. Destructive; account-bound.
 */

import { z } from 'zod';
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { backgroundTasks, taskError } from '../../background_tasks';
import { recordAccountTask } from '../../account_task_receipts';
import {
  resourceSourceInput,
  requireResourceSource,
  assertResourceSource,
} from './resource_source';

export const resourceCleanupRouter = router({
  /** Per-target on-disk size (files/bytes + ori/thumb split). Slow — stats every file. */
  listTargets: procedure.input(resourceSourceInput.optional()).query(async ({ input }) => {
    const services = requireResourceSource(input);
    const targets = await services.resourceCleanup.listTargets();
    assertResourceSource(services, input);
    return targets;
  }),

  /**
   * Delete the given targets. `variant`: 'all' wipes the whole tree, 'ori'/'thumb'
   * only removes original / preview files (ignored for non-split targets). Unknown
   * ids are silently dropped by the service's whitelist.
   */
  cleanup: procedure
    .input(
      resourceSourceInput.extend({
        instructions: z.array(
          z.object({
            id: z.string().min(1),
            variant: z.enum(['all', 'ori', 'thumb']),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      // Never delete from a static account. Its uin may match an account that
      // IS installed locally, in which case these paths resolve to that other
      // account's files — deleting them would destroy data the user never
      // pointed us at. The service's containment check can't catch this: the
      // paths are perfectly valid, just not ours to touch.
      if (getAppContext().accountIsStatic) {
        throw new Error('静态账号不提供本地资源清理：这些资源不属于导入的数据库快照。');
      }
      const services = requireResourceSource(input);
      const scope = {
        uin: services.accountConfig.getRecord()!.uin,
        configId: services.accountConfig.getRecord()?.configId,
      };
      const id = backgroundTasks.start({
        kind: 'resource',
        name: '清理本地资源',
        display: { action: '清理本地资源' },
        scope,
      });
      const save = recordAccountTask(id, scope);
      const stop = new AbortController();
      const details: string[] = [];
      const selected = [
        ...new Set(input.instructions.map((item) => `${item.id} · ${item.variant}`)),
      ];
      const completed = new Set<string>();
      const report = (working?: string) => [
        ...details,
        ...(working ? [`${working} · 清理已开始，未取得完整结果`] : []),
        ...selected
          .filter((item) => item !== working && !completed.has(item))
          .map((item) => `${item} · 未开始或没有匹配资源`),
      ];
      backgroundTasks.update(id, { details: report() });
      backgroundTasks.setActions(id, [
        {
          id: 'stop',
          label: '停止后续清理',
          run: () => {
            stop.abort();
            backgroundTasks.update(id, { statusLabel: '正在收尾当前类别' });
            backgroundTasks.setActions(id, []);
          },
        },
      ]);
      try {
        save();
        const result = await services.resourceCleanup.cleanup(input.instructions, {
          signal: stop.signal,
          before: (item) => {
            assertResourceSource(services, input);
            backgroundTasks.update(id, { details: report(`${item.id} · ${item.variant}`) });
            save();
          },
          after: (row) => {
            const key = `${row.id} · ${row.variant}`;
            completed.add(key);
            details.push(`${key} · 删除 ${row.removed} · 失败 ${row.failed}`);
            backgroundTasks.update(id, { details: report() });
            save();
          },
        });
        assertResourceSource(services, input);
        backgroundTasks.finish(
          id,
          stop.signal.aborted
            ? 'cancelled'
            : result.perTarget.some((row) => row.failed > 0)
              ? 'failed'
              : 'completed',
          {
            note: `已删除 ${result.perTarget.reduce((sum, row) => sum + row.removed, 0)} 个文件 · 失败 ${result.perTarget.reduce((sum, row) => sum + row.failed, 0)} 个 · 文件大小合计 ${(result.freedBytes / 1048576).toFixed(1)} MiB`,
            details: stop.signal.aborted ? report() : details,
          },
        );
        return result;
      } catch (error) {
        backgroundTasks.finish(id, 'failed', { note: taskError(error) });
        throw error;
      } finally {
        backgroundTasks.setActions(id, []);
        try {
          save();
        } catch (error) {
          console.warn('[资源清理] 回执保存失败', error);
        }
      }
    }),
});
