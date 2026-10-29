import { z } from 'zod';
import { backgroundTasks } from '../../background_tasks';
import { backgroundTaskVisible } from '../../../shared/background_task';
import { procedure, router } from '../trpc';

const scope = z.object({ uin: z.string(), configId: z.string().optional() }).nullable();
const ref = z.object({ id: z.string().uuid(), scope });

export const backgroundTasksRouter = router({
  list: procedure.input(scope).query(({ input }) =>
    backgroundTasks
      .snapshot()
      .filter((task) => backgroundTaskVisible(task, input))
      .map(({ details: _details, ...task }) => task),
  ),
  details: procedure.input(ref.extend({ updatedAt: z.number() })).query(({ input }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope)) throw new Error('任务已失效');
    return task.details ?? [];
  }),
  act: procedure.input(ref.extend({ action: z.string() })).mutation(async ({ input, ctx }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope)) throw new Error('任务已失效');
    if (ctx.authorize && input.action === 'open') throw new Error('请在桌面端定位本机文件');
    await backgroundTasks.act(input.id, input.action);
    return true;
  }),
  remove: procedure.input(ref.extend({ updatedAt: z.number() })).mutation(({ input }) => {
    const task = backgroundTasks.snapshot().find((task) => task.id === input.id);
    if (!task || !backgroundTaskVisible(task, input.scope) || task.updatedAt !== input.updatedAt)
      return false;
    return backgroundTasks.remove(input.id, task);
  }),
});
