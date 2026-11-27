/**
 * `account.resourceCleanup.*` — the 本地资源整理 → 清理释放 backend.
 *
 * Thin tRPC skin over `ResourceCleanupService` (see `@weq/service`): list the
 * deletable nt_data resource trees with their on-disk sizes, and execute a batch
 * of cleanup instructions. All whitelist / containment safety lives in the
 * service — this layer only shapes input. Destructive; account-bound.
 */

import { z } from 'zod/v3';
import { assertQqDatabaseWriteAllowed, withQqDatabaseWrite } from '@weq/db';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';
import { backgroundTasks, taskError } from '../../background_tasks';
import type { BackgroundTaskScope } from '../../../shared/background_task';
import { recordAccountTask } from '../../account_task_receipts';
import { holdTaskOnPage } from '../../task_page';
import {
  resourceSourceInput,
  requireResourceSource,
  assertResourceSource,
} from './resource_source';

interface CleanupRun {
  id: string;
  save: ReturnType<typeof recordAccountTask>;
  total: number;
  processed: number;
  failed: number;
  current?: string;
}
const runs = new WeakMap<AccountServices, CleanupRun>();
const taskOf = (id: string) => backgroundTasks.snapshot().find((task) => task.id === id);

function handOffCleanup(run: CleanupRun) {
  const task = taskOf(run.id);
  if (!task?.foreground || task.status !== 'running') return;
  backgroundTasks.setForeground(task.id, false);
  try {
    run.save();
  } catch (error) {
    console.warn('[资源清理] 回执保存失败', error);
  }
}

const cleanupInput = resourceSourceInput.extend({
  foreground: z.boolean().optional(),
  pageId: z.string().uuid().optional(),
  instructions: z.array(
    z.object({
      id: z.string().min(1),
      variant: z.enum(['all', 'ori', 'thumb']),
    }),
  ),
});
const cleanupPlan = z.object({
  type: z.literal('cleanup'),
  instructions: cleanupInput.shape.instructions,
  completed: z.array(
    z.object({
      id: z.string(),
      variant: z.enum(['all', 'ori', 'thumb']),
      freedBytes: z.number(),
      removed: z.number(),
      failed: z.number(),
    }),
  ),
});
type CleanupPlan = z.infer<typeof cleanupPlan>;

export function retryResourceCleanup(id: string, scope: BackgroundTaskScope, raw: unknown) {
  assertQqDatabaseWriteAllowed();
  const plan = cleanupPlan.parse(raw);
  const source = { expectedAccountUin: scope.uin, expectedAccountConfigId: scope.configId };
  const services = requireResourceSource(source);
  if (getAppContext().accountIsStatic) throw new Error('静态账号不提供本地资源清理。');
  if (taskOf(runs.get(services)?.id ?? '')?.status === 'running')
    throw new Error('正在清理本地资源，请等待本批完成');
  void withQqDatabaseWrite(() =>
    executeCleanup({ ...source, instructions: plan.instructions }, { id, plan }),
  ).catch(() => undefined);
}

async function executeCleanup(
  input: z.infer<typeof cleanupInput>,
  resume?: { id: string; plan: CleanupPlan },
) {
  // Never delete from a static account. Its uin may match an account that
  // IS installed locally, in which case these paths resolve to that other
  // account's files — deleting them would destroy data the user never
  // pointed us at. The service's containment check can't catch this: the
  // paths are perfectly valid, just not ours to touch.
  if (getAppContext().accountIsStatic) {
    throw new Error('静态账号不提供本地资源清理：这些资源不属于导入的数据库快照。');
  }
  const services = requireResourceSource(input);
  const previous = runs.get(services);
  if (previous && taskOf(previous.id)?.status === 'running')
    throw new Error('正在清理本地资源，请等待本批完成');
  const scope = {
    uin: services.accountConfig.getRecord()!.uin,
    configId: services.accountConfig.getRecord()?.configId,
  };
  const foreground =
    holdTaskOnPage(input.pageId, `resource-cleanup:${scope.configId ?? scope.uin}`, () =>
      handOffCleanup(run),
    ) || input.foreground;
  const id =
    resume?.id ??
    backgroundTasks.start({
      kind: 'resource',
      name: '清理本地资源',
      display: { action: '清理本地资源' },
      scope,
      foreground,
    });
  const record = recordAccountTask(id, scope);
  const plan: CleanupPlan = resume?.plan ?? {
    type: 'cleanup',
    instructions: input.instructions,
    completed: [],
  };
  const save = () => record(plan);
  const retry = {
    id: 'retry',
    label: '继续清理剩余范围',
    run: () => retryResourceCleanup(id, scope, plan),
  };
  backgroundTasks.resume(id);
  const stop = new AbortController();
  const details = plan.completed.map(
    (row) => `${row.id} · ${row.variant} · 删除 ${row.removed} · 失败 ${row.failed}`,
  );
  const selected = [...new Set(input.instructions.map((item) => `${item.id} · ${item.variant}`))];
  const run: CleanupRun = {
    id,
    save,
    total: selected.length,
    processed: plan.completed.length,
    failed: 0,
  };
  runs.set(services, run);
  const completed = new Set(plan.completed.map(({ id, variant }) => `${id} · ${variant}`));
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
    const remaining = plan.instructions.filter(
      ({ id, variant }) => !completed.has(`${id} · ${variant}`),
    );
    const earlier = plan.completed.slice();
    const result = await services.resourceCleanup.cleanup(remaining, {
      signal: stop.signal,
      before: (item) => {
        assertResourceSource(services, input);
        run.current = `${item.id} · ${item.variant}`;
        backgroundTasks.update(id, { details: report(run.current) });
        save();
      },
      after: (row) => {
        const key = `${row.id} · ${row.variant}`;
        completed.add(key);
        if (!row.failed) plan.completed.push(row);
        run.current = undefined;
        run.processed = completed.size;
        run.failed += row.failed;
        details.push(`${key} · 删除 ${row.removed} · 失败 ${row.failed}`);
        backgroundTasks.update(id, {
          progress: run.total ? (run.processed / run.total) * 100 : undefined,
          details: report(),
        });
        save();
      },
    });
    assertResourceSource(services, input);
    result.perTarget.unshift(...earlier);
    result.freedBytes += earlier.reduce((sum, row) => sum + row.freedBytes, 0);
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
    return { ...result, stopped: stop.signal.aborted };
  } catch (error) {
    backgroundTasks.finish(id, 'failed', { note: taskError(error) });
    throw error;
  } finally {
    run.current = undefined;
    const task = taskOf(id);
    backgroundTasks.setActions(
      id,
      task && (task.status === 'cancelled' || task.status === 'failed') ? [retry] : [],
    );
    try {
      save();
    } catch (error) {
      console.warn('[资源清理] 回执保存失败', error);
    }
  }
}

export const resourceCleanupRouter = router({
  status: procedure.input(resourceSourceInput.optional()).query(({ input }) => {
    const run = runs.get(requireResourceSource(input));
    const task = run && taskOf(run.id);
    if (!run || !task) return null;
    const { id, status, statusLabel, note, details, foreground, actions } = task;
    return {
      id,
      status,
      statusLabel,
      note,
      details,
      foreground,
      canStop: actions.some((action) => action.id === 'stop'),
      total: run.total,
      processed: run.processed,
      failed: run.failed,
      current: run.current,
    };
  }),

  control: procedure
    .input(
      resourceSourceInput.extend({
        taskId: z.string().uuid(),
        action: z.enum(['stop', 'background']),
      }),
    )
    .mutation(async ({ input }) => {
      const run = runs.get(requireResourceSource(input));
      const task = run?.id === input.taskId ? taskOf(run.id) : undefined;
      if (!run || !task) throw new Error('资源清理批次已改变，请刷新');
      if (input.action === 'stop') {
        if (task.status === 'running' && task.actions.some((action) => action.id === 'stop'))
          await backgroundTasks.act(task.id, 'stop');
      } else handOffCleanup(run);
      return true;
    }),

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
    .input(cleanupInput)
    .mutation(({ input }) => withQqDatabaseWrite(() => executeCleanup(input))),
});
