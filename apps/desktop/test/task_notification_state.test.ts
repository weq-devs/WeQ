import { expect, it } from 'vitest';
import { TaskNotificationTracker } from '../src/renderer/src/lib/taskNotificationState';
import {
  summarizeWorkspaceTasks,
  type WorkspaceTaskIndicator,
} from '../src/renderer/src/lib/workspaceIndicators';
const task = (patch: Partial<WorkspaceTaskIndicator> = {}): WorkspaceTaskIndicator => ({
  id: 'task-1',
  activity: 'running',
  result: 'v1',
  failed: false,
  ...patch,
});
it('首次和切号只建立历史基线，任务真实完成只通知一次，普通明细更新不重复', () => {
  const tracker = new TaskNotificationTracker();
  expect(tracker.update('a', [task()], true)).toEqual([]);
  expect(
    tracker.update('a', [task({ activity: 'finished' })], true).map((value) => value.event),
  ).toEqual(['taskComplete']);
  expect(tracker.update('a', [task({ activity: 'finished', result: 'v2' })], true)).toEqual([]);
  expect(tracker.update('b', [task({ activity: 'finished' })], true)).toEqual([]);
});
it('新任务、暂停和恢复原位推进，实际失败或部分失败与成功分开', () => {
  const tracker = new TaskNotificationTracker();
  tracker.update('a', [], true);
  expect(tracker.update('a', [task()], true)[0]?.event).toBe('progress');
  expect(tracker.update('a', [task({ activity: 'idle', paused: true })], true)[0]?.phase).toBe(
    '已暂停',
  );
  expect(tracker.update('a', [task()], true)[0]?.event).toBe('progress');
  expect(tracker.update('a', [task({ activity: 'finished', failed: true })], true)[0]?.event).toBe(
    'taskFailure',
  );
});
it('主动取消不是失败，已有专用进度的转发不重复派发，移除任务只清理旧进度', () => {
  const tracker = new TaskNotificationTracker();
  tracker.update('a', [task()], true);
  expect(
    tracker.update('a', [task({ activity: 'finished', cancelled: true })], true)[0]?.event,
  ).toBe('success');
  tracker.update('a', [task({ id: 'forward', notificationHandled: true })], true);
  expect(
    tracker.update(
      'a',
      [task({ id: 'forward', activity: 'finished', notificationHandled: true })],
      true,
    ),
  ).toEqual([]);
  tracker.update('a', [task({ id: 'removed' })], true);
  expect(tracker.update('a', [], true)[0]?.event).toBeNull();
});

it('漫游检查与拉取贡献同一进行中任务，进度静默，检查失败仍提醒', () => {
  const tracker = new TaskNotificationTracker();
  tracker.update('a', [], true);
  const scanning = summarizeWorkspaceTasks({
    roaming: [
      {
        id: 'roam',
        status: 'running',
        planning: { startImmediately: true },
        options: { targets: [{ name: '合成群' }] },
        targets: [],
      },
    ],
    scanning: true,
  });
  expect(scanning.running).toBe(1);
  expect(tracker.update('a', scanning.items, true)[0]?.event).toBeNull();
  const failed = summarizeWorkspaceTasks({
    roaming: [
      {
        id: 'roam',
        status: 'failed',
        planning: { startImmediately: true },
        options: { targets: [{ name: '合成群' }] },
        targets: [],
      },
    ],
  });
  expect(tracker.update('a', failed.items, true)[0]).toMatchObject({
    event: 'taskFailure',
    task: { id: 'roaming:roam', notificationName: '拉取漫游消息 · 合成群' },
  });
  const resumed = summarizeWorkspaceTasks({
    roaming: [{ id: 'roam', status: 'running', targets: [{ name: '合成群' }] }],
  });
  expect(tracker.update('a', resumed.items, true)[0]?.event).toBeNull();
});
