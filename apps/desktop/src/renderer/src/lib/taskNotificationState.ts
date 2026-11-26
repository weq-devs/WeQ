import type { WorkspaceTaskIndicator } from './workspaceIndicators';
import type { NotificationEvent } from '@weq/service/notification-settings';

export class TaskNotificationTracker {
  private scope = '';
  private previous = new Map<string, WorkspaceTaskIndicator>();
  update(
    scope: string,
    items: readonly WorkspaceTaskIndicator[],
    ready: boolean,
    presentation: { visible?: boolean; autoOpen?: boolean; started?: ReadonlySet<string> } = {},
  ) {
    const result: Array<{
      task: WorkspaceTaskIndicator;
      event: NotificationEvent | null;
      phase: string;
    }> = [];
    if (!scope || !ready) return result;
    if (this.scope !== scope) {
      this.scope = scope;
      this.previous = new Map(
        items.filter((task) => !presentation.started?.has(task.id)).map((task) => [task.id, task]),
      );
    }
    for (const task of items) {
      const before = this.previous.get(task.id);
      this.previous.delete(task.id);
      this.previous.set(task.id, task);
      if (task.archived) {
        if (before && !before.archived) result.push({ task, event: null, phase: '' });
        continue;
      }
      if (task.notificationHandled) {
        if (before && !before.notificationHandled) result.push({ task, event: null, phase: '' });
        continue;
      }
      // 展示过的状态仍记入基线，关闭列表后不补发；异常保留提醒。
      const presented =
        presentation.visible ||
        (!before && task.autoOpenTaskList !== false && presentation.autoOpen);
      const notify = (event: NotificationEvent, phase: string) => {
        const silent =
          (presented && event !== 'taskFailure') ||
          (event === 'progress' && task.showProgressNotification === false) ||
          (event === 'taskComplete' && task.showCompletionNotification === false);
        result.push({ task, event: silent ? null : event, phase });
      };
      if (task.waiting && !before?.waiting) {
        notify('taskFailure', '等待处理');
      } else if (task.cancelled) {
        if (before && !before.cancelled) notify('success', '已停止');
      } else if (
        task.activity === 'finished' &&
        (before?.activity !== 'finished' || (!before.failed && task.failed))
      ) {
        notify(
          task.failed ? 'taskFailure' : 'taskComplete',
          task.partial ? '部分完成' : task.failed ? '未完成' : '已完成',
        );
      } else if (
        (task.activity === 'running' && (before?.activity !== 'running' || before.waiting)) ||
        (task.paused && !before?.paused)
      ) {
        notify('progress', task.paused ? '已暂停' : '进行中');
      } else if (before?.waiting && !task.waiting) {
        result.push({ task, event: null, phase: '' });
      }
    }
    const present = new Set(items.map((task) => task.id));
    for (const [id, task] of this.previous)
      if (!present.has(id) && task.activity === 'running') {
        result.push({ task, event: null, phase: '' });
        this.previous.set(id, { ...task, activity: 'idle' });
      }
    while (this.previous.size > 4096) this.previous.delete(this.previous.keys().next().value!);
    return result;
  }
}
