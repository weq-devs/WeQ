import { subscribeDressIndexResources } from '@weq/service';
import { backgroundTasks } from './background_tasks';

const labels = { bubble: '气泡', font: '字体', widget: '头像挂件' };
let installed = false;

/** 桌面及内置 Web 共用宿主下载任务，不按账号重复创建。 */
export function installDressIndexTasks(): void {
  if (installed) return;
  installed = true;
  const active = new Map<string, string>();
  subscribeDressIndexResources(({ store, state }) => {
    const key = `${store.directory}:${state.kind}`;
    let taskId = active.get(key);
    if (state.status === 'downloading') {
      if (!taskId) {
        taskId = backgroundTasks.start({
          kind: 'resource',
          name: `${labels[state.kind]}离线索引`,
          progress: 0,
        });
        active.set(key, taskId);
      }
      backgroundTasks.update(taskId, {
        progress: (state.downloadedBytes / state.totalBytes) * 100,
        note: `${(state.downloadedBytes / 1024 / 1024).toFixed(1)} / ${(state.totalBytes / 1024 / 1024).toFixed(1)} MiB`,
      });
    } else if (taskId && state.status === 'ready') {
      backgroundTasks.finish(taskId, 'completed', { note: '离线索引已就绪' });
      active.delete(key);
    } else if (state.status === 'failed') {
      taskId ??= backgroundTasks.start({
        kind: 'resource',
        name: `${labels[state.kind]}离线索引`,
      });
      backgroundTasks.finish(taskId, 'failed', { note: state.error });
      const failedId = taskId;
      backgroundTasks.setActions(taskId, [
        {
          id: 'retry',
          label: '重试',
          run: () => {
            backgroundTasks.setActions(failedId, []);
            return store.ensure(state.kind, true);
          },
        },
      ]);
      active.delete(key);
    }
  });
}
