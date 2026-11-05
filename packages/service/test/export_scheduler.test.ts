import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportScheduler, type ScheduleInput } from '../src/account/export/scheduler';
import type { ExportTask, ExportTaskManager } from '../src/account/export/task_manager';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  const root = mkdtempSync(join(tmpdir(), 'weq-scheduler-'));
  const tasks = new Map<string, ExportTask>();
  const manager = Object.assign(new EventEmitter(), {
    startTask: vi.fn(async () => {
      const id = `task-${tasks.size + 1}`;
      tasks.set(id, { id, status: 'running', progress: 0, current: 0 } as ExportTask);
      return id;
    }),
    getTask: (id: string) => tasks.get(id),
    formalArchivePath: vi.fn(() => join(root, 'archive.jsonl')),
    appendLog: vi.fn(),
  });
  let online = true;
  const scheduler = new ExportScheduler(root, {
    taskManager: manager as unknown as ExportTaskManager,
    isOnline: () => online,
  });
  cleanups.push(() => {
    scheduler.stop();
    rmSync(root, { recursive: true, force: true });
  });
  const input: ScheduleInput = {
    name: 'fixture',
    enabled: true,
    format: 'txt',
    conversations: [{ id: '777', name: 'fixture', kind: 'group', total: 1 }],
    schedule: { mode: 'interval', intervalHours: 1, time: '00:00' },
    options: {
      range: { preset: 'all', start: null, end: null },
      exportMedia: false,
      completeMessages: false,
      exportAvatar: false,
      completeMedia: false,
      downloadVideo: false,
      downloadFile: false,
      downloadPtt: false,
      transcribeVoice: false,
    },
  };
  const schedule = scheduler.create(input);
  return {
    root,
    tasks,
    manager,
    scheduler,
    schedule,
    offline: () => {
      online = false;
    },
  };
}

it('books the next cadence and persists in-flight IDs before the first batch completes', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.manager.startTask).toHaveBeenCalledTimes(1);
  expect(f.schedule.history[0]?.outcome).toBe('running');
  expect(f.schedule.nextRunAt).toBeGreaterThan(Date.now() / 1000);
  expect(
    JSON.parse(readFileSync(join(f.root, 'schedules.json'), 'utf8'))[0].history[0].taskIds,
  ).toEqual(['task-1']);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.manager.startTask).toHaveBeenCalledTimes(1);
});

it.each([false, true])('定时批次沿用创建时的完整性报告选择 %s', async (includeIntegrityReport) => {
  const f = fixture();
  f.scheduler.update(f.schedule.id, { options: { ...f.schedule.options, includeIntegrityReport } });
  await f.scheduler.runNow(f.schedule.id);
  expect(f.manager.startTask).toHaveBeenCalledWith(
    expect.objectContaining({ includeIntegrityReport }),
  );
});

it('repeated manual skips cannot hide the active batch or reset the cadence', async () => {
  const f = fixture();
  const nextRun = f.schedule.nextRunAt;
  await f.scheduler.runNow(f.schedule.id);
  for (let i = 0; i < 25; i++) expect(await f.scheduler.runNow(f.schedule.id)).toEqual([]);
  expect(f.manager.startTask).toHaveBeenCalledTimes(1);
  expect(f.schedule.nextRunAt).toBe(nextRun);
});

it('serializes simultaneous manual starts before startTask resolves', async () => {
  const f = fixture();
  const results = await Promise.all([
    f.scheduler.runNow(f.schedule.id),
    f.scheduler.runNow(f.schedule.id),
  ]);
  expect(results.filter((ids) => ids.length)).toHaveLength(1);
  expect(f.manager.startTask).toHaveBeenCalledTimes(1);
});

it('settles a task that completed before its startup promise resolved', async () => {
  const f = fixture();
  f.manager.startTask.mockImplementationOnce(async () => {
    f.tasks.set('fast', {
      id: 'fast',
      status: 'completed',
      progress: 100,
      current: 1,
    } as ExportTask);
    return 'fast';
  });
  await f.scheduler.runNow(f.schedule.id);
  expect(f.schedule.history[0]?.outcome).toBe('completed');
  expect(f.manager.listenerCount('progress')).toBe(0);
});

it('offline retries are bounded and stop releases all wake timers', async () => {
  const f = fixture();
  f.scheduler.update(f.schedule.id, { options: { ...f.schedule.options, completeMessages: true } });
  f.offline();
  await vi.advanceTimersByTimeAsync(3_605_000);
  expect(f.schedule.history.length).toBeLessThanOrEqual(6);
  expect(f.manager.startTask).not.toHaveBeenCalled();
  f.scheduler.stop();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(f.manager.startTask).not.toHaveBeenCalled();
});

it('纯本地定时导出在 QQ 离线时照常运行，不让旧补全开关覆盖内容策略', async () => {
  const f = fixture();
  const { selectAllExportContent } = await import('../src/common/export_content');
  f.scheduler.update(f.schedule.id, {
    options: {
      ...f.schedule.options,
      content: selectAllExportContent('local'),
      completeMessages: true,
    },
  });
  f.offline();
  await f.scheduler.runNow(f.schedule.id);
  expect(f.manager.startTask).toHaveBeenCalledTimes(1);
  expect(f.schedule.history[0]?.outcome).toBe('running');
});

it('completion updates its original trigger without changing the next cadence', async () => {
  const f = fixture();
  await vi.advanceTimersByTimeAsync(3_600_000);
  const nextRun = f.schedule.nextRunAt;
  const task = f.tasks.get('task-1')!;
  task.status = 'completed';
  f.manager.emit('progress', { taskId: task.id, status: task.status });
  expect(f.schedule.history).toHaveLength(1);
  expect(f.schedule.history[0]?.outcome).toBe('completed');
  expect(f.schedule.nextRunAt).toBe(nextRun);
  expect(f.manager.listenerCount('progress')).toBe(0);
});

it('结构化定时任务保存成功后记住正式归档，下一轮复用同一路径与内容策略', async () => {
  const f = fixture();
  const { selectAllExportContent } = await import('../src/common/export_content');
  const content = { ...selectAllExportContent('local'), font: 'cloud' as const };
  f.scheduler.update(f.schedule.id, {
    format: 'jsonl',
    formats: ['jsonl'],
    options: {
      ...f.schedule.options,
      exportMedia: true,
      content,
      completeAvatar: false,
      completeDressKinds: { bubble: false, font: true, widget: false },
    },
  });
  await f.scheduler.runNow(f.schedule.id);
  const first = f.tasks.get('task-1')!;
  Object.assign(first, {
    kind: 'group',
    conv: '777',
    archiveId: 'original-archive',
    status: 'completed',
    save: { status: 'saved' },
  });
  f.manager.emit('progress', { taskId: first.id, status: 'completed' });
  const path = join(f.root, 'archive.jsonl');
  expect(f.schedule.archives).toEqual({ 'group:777': path });
  expect(JSON.parse(readFileSync(join(f.root, 'schedules.json'), 'utf8'))[0].archives).toEqual({
    'group:777': path,
  });
  await f.scheduler.runNow(f.schedule.id);
  expect(f.manager.startTask).toHaveBeenLastCalledWith(
    expect.objectContaining({
      baselineDirectory: path,
      content,
      completeAvatar: false,
      media: expect.objectContaining({
        completeDressKinds: { bubble: false, font: true, widget: false },
      }),
    }),
  );
});
