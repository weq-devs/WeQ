import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ExportTaskManager, type ExportTask } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import { selectAllExportContent } from '../src/common/export_content';

it.each(['complete', 'missing', 'absent', 'resumed'] as const)(
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
              {
                msgId: '3',
                senderUin: '789',
                sendNick: '另一位记录作者',
                sendTime: '1700000001',
                elements: [{ type: 'text' as const, data: { textContent: '任务内第二条正文' } }],
              },
            ],
      );
      const getC2cSeqDesc = vi.fn(async () => ({ seqs: [3n, 1n], below: null, above: null }));
      const fetch = vi.fn(async () => {
        throw new Error('精确导出不应拉取会话历史');
      });
      const cached = vi.fn(async () => []);
      const source = {
        getC2cSeqDesc,
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
      const forwardTarget = { elementIndex: 0, resId: 'fixture' };
      const input = {
        kind: 'c2c' as const,
        conv: 'peer',
        name: '记录',
        format: 'txt' as const,
        total: 1,
        filter: { messageIds: ['1'], forwardTarget },
        content: { ...selectAllExportContent('none'), messages: 'cloud' as const },
        media: {
          exportMedia: false,
          completeMessages: false,
          completeMedia: false,
          downloadPtt: false,
          downloadVideo: false,
          downloadFile: false,
          transcribeVoice: false,
        },
      };
      const cacheDir = join(root, 'cache');
      const legacyId = 'legacy-paused-export';
      if (mode === 'resumed') {
        const legacy: ExportTask = {
          ...input,
          media: { ...input.media, completeMessages: true },
          id: legacyId,
          status: 'paused',
          progress: 10,
          current: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          stages: [
            { key: 'backfill', label: '补全缺失消息', status: 'running', current: 1, total: 3 },
            { key: 'message', label: '导出消息', status: 'pending', current: 0, total: 1 },
          ],
        };
        await mkdir(cacheDir);
        await writeFile(join(cacheDir, 'export_tasks.json'), JSON.stringify([legacy]));
      }
      const manager = new ExportTaskManager(source, cacheDir, {
        fetchForward,
        messageBackfill: { fetch, cached },
      });
      const id =
        mode === 'resumed'
          ? legacyId
          : await manager.startTask({ ...input, savePolicy: { mode: 'before', directory: root } });
      if (mode === 'resumed') expect(manager.resumeTask(id)).toBe(true);
      else
        expect(manager.getTask(id)?.stages.some((stage) => stage.key === 'backfill')).toBe(false);
      forwardTarget.resId = 'changed-after-start';
      expect(manager.getTask(id)?.filter?.forwardTarget?.resId).toBe('fixture');
      await vi.waitFor(
        () => expect(['completed', 'failed']).toContain(manager.getTask(id)?.status),
        { timeout: 10000 },
      );
      const task = manager.getTask(id)!;
      expect(task.stages.some((stage) => stage.key === 'backfill')).toBe(false);
      expect(getC2cSeqDesc).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(cached).not.toHaveBeenCalled();
      if (mode === 'complete' || mode === 'resumed') {
        expect(task.status, task.error).toBe('completed');
        if (mode === 'complete')
          await vi.waitFor(() => expect(task.save?.status, task.error).toBe('saved'), {
            timeout: 10000,
          });
        expect(fetchForward).toHaveBeenCalledWith('fixture');
        const contents = await readFile(task.filePath!, 'utf8');
        expect(contents).toContain('记录作者');
        expect(contents).toContain('任务内完整正文');
        expect(contents).toContain('任务内第二条正文');
        expect(contents).not.toContain('10002');
        expect(contents).not.toContain('[聊天记录]');
        expect(task.current).toBe(2);
        expect(task.total).toBe(2);
      } else {
        expect(task.status).toBe('failed');
        expect(task.error).toContain('重试');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
