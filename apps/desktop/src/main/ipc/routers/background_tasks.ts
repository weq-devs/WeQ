import { z } from 'zod/v3';
import { backgroundTasks } from '../../background_tasks';
import { backgroundTaskVisible } from '../../../shared/background_task';
import { procedure, router } from '../trpc';
import { hideAnalysisReportTask, restoreAnalysisReportTasks } from './analysis_reports';
import { getAppContext } from '../../context/app_context';
import { removeCalendarTask, restoreCalendarTasks } from './conversation_calendar';
import { getUpdateActions } from '../../update/state';
import { forgetEnhancementTask } from '../../enhancements/tasks';
import { forgetRecordedTask, restoreRecordedTasks } from '../../account_task_receipts';
import { retryRecordedClone } from './account';

const scope = z.object({ uin: z.string(), configId: z.string().optional() }).nullable();
const ref = z.object({ id: z.string().uuid(), scope });

export const backgroundTasksRouter = router({
  list: procedure.input(scope).query(async ({ input }) => {
    if (input?.configId) {
      restoreRecordedTasks(input, retryRecordedClone);
      restoreCalendarTasks(input);
      await restoreAnalysisReportTasks({
        expectedAccountUin: input.uin,
        expectedAccountConfigId: input.configId,
      });
    }
    return backgroundTasks
      .snapshot()
      .filter((task) => !task.foreground && backgroundTaskVisible(task, input))
      .map(
        ({ details: _details, logs: _logs, contactFailures: _contactFailures, ...task }) => task,
      );
  }),
  details: procedure.input(ref.extend({ updatedAt: z.number() })).query(({ input }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope)) throw new Error('任务已失效');
    return task.details ?? [];
  }),
  logs: procedure.input(ref.extend({ updatedAt: z.number() })).query(({ input }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope)) throw new Error('任务已失效');
    return task.logs ?? [];
  }),
  contactFailures: procedure
    .input(ref.extend({ lane: z.enum(['friends', 'groups']) }))
    .query(({ input }) => {
      const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
      if (task?.kind !== 'contacts' || !backgroundTaskVisible(task, input.scope))
        throw new Error('任务已失效');
      return task.contactFailures?.filter((item) => item.lane === input.lane) ?? [];
    }),
  act: procedure.input(ref.extend({ action: z.string() })).mutation(async ({ input, ctx }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope)) throw new Error('任务已失效');
    if (ctx.authorize && input.action === 'open') throw new Error('请在桌面端定位本机文件');
    if (ctx.authorize && task.kind === 'update') throw new Error('仅允许桌面端管理应用更新。');
    await backgroundTasks.act(input.id, input.action);
    return true;
  }),
  remove: procedure
    .input(ref.extend({ updatedAt: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
      if (
        !task ||
        task.status === 'running' ||
        !backgroundTaskVisible(task, input.scope) ||
        task.updatedAt !== input.updatedAt
      )
        return false;
      if (task.kind === 'contacts') {
        const services = getAppContext().services;
        const account = services?.accountConfig.getRecord();
        if (account?.uin !== task.scope?.uin || account?.configId !== task.scope?.configId)
          return false;
        await services?.contactDirectory?.removeRefreshTask(task.id);
      }
      if (task.kind === 'calendar' && !removeCalendarTask(task)) return false;
      if (task.kind === 'update') {
        if (ctx.authorize || getUpdateActions().forgetDownloadTask?.(task.id) === false)
          return false;
      }
      if (task.kind === 'model' && task.destination === 'enhancement-packs') {
        const packs = getAppContext().bootstrap?.enhancements?.packs;
        if (packs && !forgetEnhancementTask(packs, task.id)) return false;
      }
      if (task.kind === 'analysis' && task.reportId) {
        await hideAnalysisReportTask(task.reportId);
        backgroundTasks.remove(input.id, task);
        return true;
      }
      forgetRecordedTask(task);
      return backgroundTasks.remove(input.id, task);
    }),
});
