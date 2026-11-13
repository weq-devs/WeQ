import { z } from 'zod';
import { backgroundTasks } from '../../background_tasks';
import { backgroundTaskVisible } from '../../../shared/background_task';
import { procedure, router } from '../trpc';
import { hideAnalysisReportTask, restoreAnalysisReportTasks } from './analysis_reports';

const scope = z.object({ uin: z.string(), configId: z.string().optional() }).nullable();
const ref = z.object({ id: z.string().uuid(), scope });

export const backgroundTasksRouter = router({
  list: procedure.input(scope).query(({ input }) => {
    if (input?.configId)
      restoreAnalysisReportTasks({
        expectedAccountUin: input.uin,
        expectedAccountConfigId: input.configId,
      });
    return backgroundTasks
      .snapshot()
      .filter((task) => backgroundTaskVisible(task, input))
      .map(({ details: _details, logs: _logs, ...task }) => task);
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
  act: procedure.input(ref.extend({ action: z.string() })).mutation(async ({ input, ctx }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope)) throw new Error('任务已失效');
    if (ctx.authorize && input.action === 'open') throw new Error('请在桌面端定位本机文件');
    await backgroundTasks.act(input.id, input.action);
    return true;
  }),
  remove: procedure.input(ref.extend({ updatedAt: z.number() })).mutation(async ({ input }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope) || task.updatedAt !== input.updatedAt)
      return false;
    if (task.kind === 'analysis' && task.reportId) {
      await hideAnalysisReportTask(task.reportId);
      backgroundTasks.remove(input.id, task);
      return true;
    }
    return backgroundTasks.remove(input.id, task);
  }),
});
