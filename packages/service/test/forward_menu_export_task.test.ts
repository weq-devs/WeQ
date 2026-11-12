import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

it.each(['complete', 'missing', 'absent'] as const)(
  '右键记录导出任务 %s：精确选区仍允许补全卡片，缺失内容不报成功',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-menu-record-task-'));
    try {
      const fetchForward = vi.fn(async () =>
        mode === 'missing'
          ? []
          : [
              {
                msgId: '2',
                senderUin: '456',
                sendNick: '记录作者',
                sendTime: '1700000000',
                elements: [{ type: 'text' as const, data: { textContent: '任务内完整正文' } }],
              },
            ],
      );
      const source = {
        takeSalvageSkips: () => [],
        async *exportC2cMessages() {
          if (mode === 'absent') return;
          yield {
            msgId: 1n,
            msgSeq: 1n,
            targetUid: 'peer',
            targetUin: 10002n,
            senderUid: 'peer',
            senderUin: 10002n,
            sendTime: 1700000000n,
            elements: [
              { type: 'multiMsg', data: { resId: 'fixture', sessionId: '', xmlContent: '' } },
            ],
          };
        },
        listForward: async () => [],
      } as unknown as MsgService;
      const manager = new ExportTaskManager(source, join(root, 'cache'), { fetchForward });
      const forwardTarget = { elementIndex: 0, resId: 'fixture' };
      const id = await manager.startTask({
        kind: 'c2c',
        conv: 'peer',
        name: '记录',
        format: 'txt',
        formats: ['txt'],
        total: 1,
        filter: { messageIds: ['1'], forwardTarget },
        savePolicy: { mode: 'before', directory: root },
      });
      forwardTarget.resId = 'changed-after-start';
      expect(manager.getTask(id)?.filter?.forwardTarget?.resId).toBe('fixture');
      await vi.waitFor(
        () => expect(['completed', 'failed']).toContain(manager.getTask(id)?.status),
        { timeout: 10000 },
      );
      const task = manager.getTask(id)!;
      if (mode === 'complete') {
        expect(task.status, task.error).toBe('completed');
        await vi.waitFor(() => expect(task.save?.status, task.error).toBe('saved'), {
          timeout: 10000,
        });
        expect(fetchForward).toHaveBeenCalled();
        const contents = await readFile(task.filePath!, 'utf8');
        expect(contents).toContain('记录作者');
        expect(contents).toContain('任务内完整正文');
      } else {
        expect(task.status).toBe('failed');
        expect(task.error).toContain('重试');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
