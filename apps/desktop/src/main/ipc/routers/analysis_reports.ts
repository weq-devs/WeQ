import { z } from 'zod';
import { observable } from '@trpc/server/observable';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { withDatabaseSignal } from '@weq/db';
import { AnalysisReportsService } from '@weq/service';
import { getAppContext, accountEventBus, type AccountServices } from '../../context/app_context';
import { backgroundTasks } from '../../background_tasks';
import { procedure, router } from '../trpc';
import { resolveChildWorkerPath } from '../../worker_path';

const binding = z.object({
  expectedAccountUin: z.string().min(1),
  expectedAccountConfigId: z.string().min(1),
});
const ref = binding.extend({ id: z.string().min(1).max(128) });
const scope = binding.extend({
  startTime: z.number().int().nonnegative().optional(),
  endTime: z.number().int().nonnegative().optional(),
  messageIds: z.array(z.string()).optional(),
});
const request = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum(['buddy', 'group', 'member']),
    name: z.string(),
    period: z.string(),
    peerUid: z.string().optional(),
    groupCode: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    groupName: z.string().optional(),
    memberUid: z.string().optional(),
    memberUin: z
      .string()
      .regex(/^[1-9]\d*$/)
      .optional(),
    scope,
  })
  .refine(
    (value) =>
      value.kind === 'buddy'
        ? Boolean(value.peerUid)
        : Boolean(
            value.groupCode && (value.kind === 'group' || value.memberUid || value.memberUin),
          ),
    '分析对象不完整',
  );

const stores = new WeakMap<AccountServices, AnalysisReportsService>();
let restoreStore: ((input: z.infer<typeof binding>) => AnalysisReportsService) | undefined;
export function restoreAnalysisReportTasks(input: z.infer<typeof binding>) {
  return restoreStore?.(input);
}
export async function hideAnalysisReportTask(id: string) {
  const services = getAppContext().services;
  const current = services && stores.get(services);
  if (!current) throw new Error('账号已关闭');
  await current.hideTask(id);
}
export function createAnalysisReportsRouter(
  resolve: (input: z.infer<typeof binding>) => AccountServices,
) {
  function store(input: z.infer<typeof binding>) {
    const services = resolve(input);
    let service = stores.get(services);
    if (service) return service;
    const ctx = getAppContext();
    if (!ctx.platform) throw new Error('账号尚未就绪');
    const key = createHash('sha256')
      .update(JSON.stringify([input.expectedAccountConfigId, input.expectedAccountUin]))
      .digest('hex');
    service = new AnalysisReportsService(
      join(ctx.platform.appDataRoot(), 'analysis-reports', key),
      (request, stage, signal) =>
        withDatabaseSignal(signal, async () => {
          if (resolve(input) !== services) throw new Error('账号已切换');
          const range = request.scope;
          if (request.kind === 'buddy')
            return services.buddyAnalytics.getBuddyAnalytics(request.peerUid!, range);
          const group = BigInt(request.groupCode!);
          if (request.kind === 'member')
            return services.groupInfo.getGroupMemberAnalytics(
              group,
              request.memberUid ?? '',
              range.startTime,
              range.endTime,
              request.memberUin,
              range.messageIds,
            );
          if (stage === 'batches') return services.groupInfo.getGroupJoinBatches(group, range);
          if (stage === 'graph') return services.groupInfo.getGroupConversationGraph(group, range);
          return services.groupInfo.getGroupStatsReport(group, {
            ...range,
            rankingLimit: 10,
            wordLimit: 150,
          });
        }),
      resolveChildWorkerPath('analysisReportsWorker.mjs', import.meta.dirname),
    );
    stores.set(services, service);
    const current = service;
    const taskIds = new Map<string, string>();
    const projected = new Map<string, number>();
    let sync = Promise.resolve();
    const project = () => {
      sync = sync
        .then(async () => {
          const reports = await current.list();
          const visible = new Set(
            reports.filter((report) => !report.taskHidden).map((report) => report.request.id),
          );
          for (const [id, taskId] of taskIds) {
            if (!visible.has(id)) {
              backgroundTasks.finish(taskId, 'cancelled');
              backgroundTasks.remove(taskId);
              taskIds.delete(id);
              projected.delete(id);
            }
          }
          for (const report of reports.toReversed()) {
            const id = report.request.id;
            if (report.taskHidden || projected.get(id) === report.updatedAt) continue;
            let taskId = taskIds.get(id);
            if (!taskId) {
              const hash = createHash('sha256').update(`${key}:${id}`).digest('hex');
              taskId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
              taskIds.set(id, taskId);
            }
            const total = report.request.kind === 'group' ? 3 : 1;
            const patch = {
              progress: Math.round((report.completed.length / total) * 100),
              note: report.error,
              logs: report.logs.map((line, seq) => ({
                ...line,
                seq,
                stage: 'analysis',
                level: 'info' as const,
              })),
            };
            backgroundTasks.project(
              {
                ...patch,
                id: taskId,
                kind: 'analysis',
                reportId: id,
                name: `${report.request.name} · 分析`,
                scope: { uin: input.expectedAccountUin, configId: input.expectedAccountConfigId },
                status: report.status,
                startedAt: report.logs[0]?.ts ?? report.updatedAt,
                updatedAt: report.updatedAt,
                actions: [],
              },
              [
                { id: 'view-report', label: '查看报告', run: () => undefined },
                ...(report.status === 'running'
                  ? [{ id: 'cancel', label: '取消', run: () => current.cancel(id) }]
                  : report.status !== 'completed'
                    ? [
                        {
                          id: 'resume',
                          label: report.status === 'failed' ? '重试' : '继续',
                          run: () => current.resume(id),
                        },
                      ]
                    : []),
              ],
            );
            projected.set(id, report.updatedAt);
          }
        })
        .catch((error: unknown) => console.error('[analysis-reports] 任务更新失败', error));
    };
    current.on('changed', project);
    current.on('storageError', (error: unknown) => {
      console.error('[analysis-reports] 报告保存失败', error);
      for (const taskId of taskIds.values())
        backgroundTasks.finish(taskId, 'failed', { note: '报告保存失败，请检查存储后重试' });
    });
    project();
    const account = ctx.account;
    const closing = (target: unknown) => {
      if (target !== account) return;
      accountEventBus.off('closing', closing);
      current.off('changed', project);
      void sync
        .then(() => current.dispose())
        .catch((error: unknown) => console.error('[analysis-reports] 保存失败', error));
    };
    accountEventBus.on('closing', closing);
    return current;
  }
  restoreStore = store;
  return router({
    create: procedure.input(request).mutation(async ({ input }) => {
      const current = store(input.scope);
      const report = await current.create(input);
      await current.resume(input.id);
      return report;
    }),
    list: procedure.input(binding).query(({ input }) => store(input).list()),
    get: procedure.input(ref).query(({ input }) => store(input).get(input.id)),
    versions: procedure.input(ref).query(({ input }) => store(input).versions(input.id)),
    version: procedure
      .input(ref.extend({ version: z.number().int().positive() }))
      .query(({ input }) => store(input).version(input.id, input.version)),
    resume: procedure
      .input(ref.extend({ refresh: z.boolean().optional() }))
      .mutation(({ input }) => store(input).resume(input.id, input.refresh)),
    revise: procedure
      .input(
        ref.extend({
          startTime: z.number().int().nonnegative(),
          endTime: z.number().int().nonnegative(),
        }),
      )
      .mutation(({ input }) => store(input).revise(input.id, input)),
    cancel: procedure.input(ref).mutation(({ input }) => store(input).cancel(input.id)),
    retry: procedure.input(ref).mutation(({ input }) => store(input).resume(input.id)),
    remove: procedure.input(ref).mutation(({ input }) => store(input).remove(input.id)),
    position: procedure
      .input(ref.extend({ position: z.number().nonnegative().finite() }))
      .mutation(({ input }) => store(input).position(input.id, input.position)),
    onChange: procedure.input(binding).subscription(({ input }) =>
      observable<string>((emit) => {
        const current = store(input);
        const listener = (id: string) => emit.next(id);
        current.on('changed', listener);
        return () => {
          current.off('changed', listener);
        };
      }),
    ),
  });
}
