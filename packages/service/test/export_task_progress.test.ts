import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExportTaskManager, type ExportTask } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

function messages(): MsgService {
  return {
    countConv: async () => 2,
    takeSalvageSkips: () => [],
    async *exportC2cMessages() {
      for (let i = 1; i <= 2; i++)
        yield {
          msgId: BigInt(i),
          msgSeq: BigInt(i),
          targetUid: 'peer',
          targetUin: 10002n,
          senderUid: 'peer',
          senderUin: 10002n,
          sendTime: 1793800000n,
          elements: [{ type: 'text', data: { textContent: `消息 ${i}` } }],
        };
    },
  } as unknown as MsgService;
}

describe('消息导出进度与收尾', () => {
  it.each([undefined, false, true])(
    '任务列表展开策略随任务保存并返回：%s',
    async (autoOpenTaskList) => {
      const root = await mkdtemp(join(tmpdir(), 'weq-export-presentation-'));
      try {
        const cache = join(root, 'cache');
        const manager = new ExportTaskManager(messages(), cache);
        const id = await manager.startTask({
          autoOpenTaskList,
          kind: 'c2c',
          conv: 'peer',
          name: '展开策略',
          format: 'txt',
          total: 2,
          includeIntegrityReport: false,
          savePolicy: { mode: 'before', directory: root },
        });
        expect(manager.listTasks().find((task) => task.id === id)?.autoOpenTaskList).toBe(
          autoOpenTaskList,
        );
        await vi.waitFor(() =>
          expect(manager.getTask(id)?.status, manager.getTask(id)?.error).toBe('completed'),
        );
        const restored = new ExportTaskManager(messages(), cache);
        expect(restored.listTasks().find((task) => task.id === id)?.autoOpenTaskList).toBe(
          autoOpenTaskList,
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([0, 1, 3])('实际消息数取代初始估计 %i，多格式不重复计数', async (total) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-export-progress-'));
    try {
      const manager = new ExportTaskManager(messages(), join(root, 'cache'));
      const id = await manager.startTask({
        kind: 'c2c',
        conv: 'peer',
        name: '消息计数',
        format: 'json',
        formats: ['json', 'jsonl', 'xlsx', 'csv', 'txt', 'html'],
        total,
        includeIntegrityReport: false,
        savePolicy: { mode: 'before', directory: root },
      });
      await vi.waitFor(() =>
        expect(manager.getTask(id)?.status, manager.getTask(id)?.error).toBe('completed'),
      );
      expect(manager.getTask(id)).toMatchObject({ current: 2, total: 2, progress: 100 });
      expect(Object.values(manager.getTask(id)!.formatCounts!)).toEqual([2, 2, 2, 2, 2, 2]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['complete', 'fail', 'pause'] as const)(
    '文件校验期间显示收尾，未完成时不报 100%%：%s',
    async (outcome) => {
      const root = await mkdtemp(join(tmpdir(), 'weq-export-finalize-'));
      let release = (): void => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        const manager = new ExportTaskManager(messages(), join(root, 'cache'));
        const internal = manager as unknown as {
          hashMessageOutputs(task: ExportTask): Promise<Record<string, string>>;
        };
        const hash = internal.hashMessageOutputs.bind(manager);
        let checking = false;
        vi.spyOn(internal, 'hashMessageOutputs').mockImplementation(async (task) => {
          checking = true;
          await gate;
          if (outcome === 'fail') throw new Error('校验失败夹具');
          return hash(task);
        });
        const events: Array<{ status: string; progress: number }> = [];
        manager.on('progress', ({ status, progress }) => events.push({ status, progress }));
        const id = await manager.startTask({
          kind: 'c2c',
          conv: 'peer',
          name: '收尾状态',
          format: 'txt',
          total: 1,
          includeIntegrityReport: false,
          savePolicy: { mode: 'before', directory: root },
        });
        await vi.waitFor(() => expect(checking).toBe(true));
        const task = manager.getTask(id)!;
        // 先释放夹具，后续断言失败也不会留下在途任务。
        const before = structuredClone(task);
        if (outcome === 'pause') expect(manager.pauseTask(id)).toBe(true);
        release();
        const status =
          outcome === 'complete' ? 'completed' : outcome === 'fail' ? 'failed' : 'paused';
        await vi.waitFor(() => expect(task.status).toBe(status));
        await vi.waitFor(() =>
          expect(manager.listTasks().find((t) => t.id === id)?.canResume).toBe(
            outcome !== 'complete',
          ),
        );
        expect(before.status).toBe('running');
        expect(before.progress).toBeLessThan(100);
        expect(before.total).toBe(before.current);
        expect(before.stages.find((s) => s.key === 'finalize')).toMatchObject({
          status: 'running',
          note: '校验导出文件…',
        });
        expect(
          events
            .filter((event) => event.status === 'running')
            .every((event) => event.progress < 100),
        ).toBe(true);
        expect(task.status).toBe(status);
        expect(task.stages.find((s) => s.key === 'finalize')?.status).toBe(
          outcome === 'complete' ? 'completed' : outcome === 'fail' ? 'failed' : 'running',
        );
        if (outcome === 'complete') {
          expect(task.progress).toBe(100);
          expect(events.filter((event) => event.status === 'completed')).toHaveLength(1);
        } else {
          expect(task.progress).toBeLessThan(100);
          expect(manager.listTasks().find((t) => t.id === id)?.logs).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ text: expect.stringMatching(/^导出完成：/) }),
            ]),
          );
        }
        if (outcome === 'pause') {
          // 模拟旧版任务没有收尾阶段的情况，继续时应自动补齐并重新完成校验。
          task.stages = task.stages.filter((s) => s.key !== 'finalize');
          expect(manager.resumeTask(id)).toBe(true);
          await vi.waitFor(() => expect(task.status, task.error).toBe('completed'));
          expect(task.stages.find((s) => s.key === 'finalize')).toMatchObject({
            status: 'completed',
            current: 4,
            total: 4,
          });
          expect(task.progress).toBe(100);
          expect(
            events
              .filter((event) => event.status === 'running')
              .every((event) => event.progress < 100),
          ).toBe(true);
        }
      } finally {
        release();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
