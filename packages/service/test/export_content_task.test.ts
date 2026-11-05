import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import { readArchiveFile } from '../src/account/export/archive';
import type { MsgService } from '../src/account/msg';
import type { DressService } from '../src/account/dress_service';
import { selectAllExportContent } from '../src/common/export_content';

const text = '不应写入资源明细的正文';
function messages(): MsgService {
  return {
    takeSalvageSkips: () => [],
    async *exportC2cMessages() {
      yield {
        msgId: 1n,
        msgSeq: 1n,
        targetUid: 'peer',
        targetUin: 10002n,
        senderUid: 'peer',
        senderUin: 10002n,
        sendTime: 1793800000n,
        elements: [
          { type: 'text', data: { textContent: text } },
          {
            type: 'pic',
            data: {
              fileName: 'abc.png',
              subType: 0,
              imgWidth: 200,
              imgHeight: 100,
              fileSize: 10,
              fileToken: '',
              originalUrl: '',
              uploadTime: 0,
              uploadTimestamp: 0,
              fileTTL: 0,
            },
          },
        ],
      };
    },
  } as unknown as MsgService;
}
describe('导出内容任务', () => {
  it('格式全不选时装扮只走本地资源链，配置文件仍随资源保留', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-dress-only-'));
    try {
      const file = join(root, 'bubble.png');
      await writeFile(file, 'local-bubble');
      const fetchBubble = vi.fn();
      const dress = {
        hasLocal: () => true,
        localBubble: () => ({
          localFile: file,
          slice: { top: 1, right: 1, bottom: 1, left: 1 },
          imageSize: { width: 2, height: 2 },
          textColor: '#000',
        }),
        bubbleConfig: vi.fn(async (_id: number, localOnly: boolean) => {
          expect(localOnly).toBe(true);
          return null;
        }),
        fetchBubble,
      } as unknown as DressService;
      const source = Object.assign(messages(), {
        getMsgDecoration: async () => ({ bubbleId: 1, fontId: 0, widgetId: 0 }),
      });
      const manager = new ExportTaskManager(source, join(root, 'cache'), { dressInstall: dress });
      const id = await manager.startTask({
        kind: 'c2c',
        conv: 'peer',
        name: '仅装扮',
        format: 'json',
        formats: [],
        includeIntegrityReport: false,
        content: { ...selectAllExportContent('none'), bubble: 'local' },
        savePolicy: { mode: 'before', directory: root },
      });
      await vi.waitFor(() =>
        expect(manager.getTask(id)?.save?.status, manager.getTask(id)?.error).toBe('saved'),
      );
      const task = manager.getTask(id)!;
      expect(
        await readFile(join(task.bundleDir!, 'dress', 'bubble', '1', 'static.png'), 'utf8'),
      ).toBe('local-bubble');
      expect(task.filePath).toBeUndefined();
      expect(fetchBubble).not.toHaveBeenCalled();
      expect(await readdir(task.bundleDir!)).not.toContain('仅装扮.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('格式全不选时只导出媒体，不暗中生成 JSON 或聊天正文', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-media-only-'));
    try {
      const nt = join(root, 'nt'),
        date = new Date(1793800000 * 1000);
      const original = join(
        nt,
        'Pic',
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
        'Ori',
      );
      await mkdir(original, { recursive: true });
      await writeFile(join(original, 'abc.png'), 'chosen-original');
      const manager = new ExportTaskManager(messages(), join(root, 'cache'), {
        ntDataDir: nt,
        exportAccountUin: '10001',
      });
      const id = await manager.startTask({
        kind: 'c2c',
        conv: 'peer',
        name: '仅媒体',
        format: 'json',
        formats: [],
        includeIntegrityReport: false,
        content: { ...selectAllExportContent('none'), images: 'local' },
        savePolicy: { mode: 'before', directory: root },
      });
      await vi.waitFor(() =>
        expect(manager.getTask(id)?.save?.status, manager.getTask(id)?.error).toBe('saved'),
      );
      const task = manager.getTask(id)!;
      expect(task.formats).toEqual([]);
      expect(task.filePath).toBeUndefined();
      expect(await readFile(join(task.bundleDir!, 'media', 'image', 'abc.png'), 'utf8')).toBe(
        'chosen-original',
      );
      expect(
        (await readdir(task.bundleDir!, { recursive: true })).filter((name) =>
          /\.(json|jsonl|txt)$/.test(name),
        ),
      ).toEqual([]);
      expect(manager.listTasks().find((task) => task.id === id)?.canIncremental).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('调用层不能绕过附加数据的结构化格式依赖', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-content-dependency-'));
    try {
      const manager = new ExportTaskManager(messages(), join(root, 'cache'));
      await expect(
        manager.startTask({
          kind: 'c2c',
          conv: 'peer',
          name: '属性',
          format: 'txt',
          formats: [],
          content: {
            ...selectAllExportContent('none'),
            images: 'local',
            details: { imageProperties: 'local' },
          },
          savePolicy: { mode: 'before', directory: root },
        }),
      ).rejects.toThrow('JSON/JSONL');
      expect(manager.listTasks()).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['json', 'txt'] as const)(
    '关闭全部父项后，仅图片属性能导出为 %s 且不夹带正文',
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), 'weq-content-task-'));
      try {
        const manager = new ExportTaskManager(messages(), join(root, 'cache'), {
          exportAccountUin: '10001',
        });
        const id = await manager.startTask({
          kind: 'c2c',
          conv: 'peer',
          name: '属性',
          format,
          ...(format === 'txt' ? { formats: ['txt', 'json'] as Array<'txt' | 'json'> } : {}),
          content: { ...selectAllExportContent('none'), details: { imageProperties: 'local' } },
          savePolicy: { mode: 'before', directory: root },
        });
        await vi.waitFor(() =>
          expect(manager.getTask(id)?.status, JSON.stringify(manager.getTask(id))).toBe(
            'completed',
          ),
        );
        const task = manager.getTask(id)!;
        const output = await readFile(task.filePath!, 'utf8');
        expect(output).not.toContain(text);
        expect(output).toContain('imgWidth');
        expect(output).not.toContain('"kind":"message"');
        if (format === 'json') {
          const { archive } = await readArchiveFile(task.filePath!, format);
          expect(archive.records).toHaveLength(1);
          expect(archive.records[0]?.kind).toBe('resource-directory');
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('仅选图片已有版本会带出缩略图，但不夹带其他缓存文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'weq-variant-task-'));
    try {
      const nt = join(root, 'nt');
      const month = new Date(1793800000 * 1000);
      const thumb = join(
        nt,
        'Pic',
        `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`,
        'Thumb',
      );
      await mkdir(thumb, { recursive: true });
      await writeFile(join(thumb, 'abc_0.png'), 'chosen-thumbnail');
      await writeFile(join(thumb, 'unselected_0.png'), 'not-chosen');
      const manager = new ExportTaskManager(messages(), join(root, 'cache'), {
        ntDataDir: nt,
        exportAccountUin: '10001',
      });
      const id = await manager.startTask({
        kind: 'c2c',
        conv: 'peer',
        name: '已有版本',
        format: 'json',
        content: { ...selectAllExportContent('none'), details: { imageVariants: 'local' } },
        savePolicy: { mode: 'before', directory: root },
      });
      await vi.waitFor(() =>
        expect(manager.getTask(id)?.save?.status, JSON.stringify(manager.getTask(id))).toBe(
          'saved',
        ),
      );
      const task = manager.getTask(id)!;
      const { archive } = await readArchiveFile(task.filePath!, 'json');
      expect(archive.resources).toEqual([
        expect.objectContaining({ status: 'saved', role: 'thumbnail' }),
      ]);
      expect(
        await readFile(join(task.bundleDir!, String(archive.resources[0]?.path)), 'utf8'),
      ).toBe('chosen-thumbnail');
      expect((await readdir(task.bundleDir!, { recursive: true })).join('\n')).not.toContain(
        'unselected',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each(['json', 'jsonl'] as const)(
    '任务选择原 %s 文件时原位续写，不生成每轮全量子包',
    async (format) => {
      const root = await mkdtemp(join(tmpdir(), 'weq-increment-task-'));
      try {
        const source = messages();
        const manager = new ExportTaskManager(source, join(root, 'cache'), {
          exportAccountUin: '10001',
        });
        const content = { ...selectAllExportContent('none'), messages: 'local' as const };
        const first = await manager.startTask({
          kind: 'c2c',
          conv: 'peer',
          name: '会话',
          format,
          content,
          savePolicy: { mode: 'before', directory: root },
        });
        await vi.waitFor(() =>
          expect(manager.getTask(first)?.status, manager.getTask(first)?.error).toBe('completed'),
        );
        const path = manager.formalArchivePath(first)!;
        const before = (await readArchiveFile(path, format)).archive;
        const second = await manager.startTask({
          kind: 'c2c',
          conv: 'peer',
          name: '会话',
          format,
          content,
          baselineDirectory: path,
          savePolicy: { mode: 'before', directory: root },
        });
        await vi.waitFor(() =>
          expect(manager.getTask(second)?.status, manager.getTask(second)?.error).toBe('completed'),
        );
        expect(manager.getTask(second)?.filePath).toBe(path);
        const after = (await readArchiveFile(path, format)).archive;
        expect(after.archiveId).toBe(before.archiveId);
        expect(after.records).toHaveLength(before.records.length);
        expect(after.observations).toHaveLength(before.observations.length * 2);
        expect(manager.listTasks().find((task) => task.id === first)?.canIncremental).toBe(true);
        expect(manager.resumeTask(first, true)).toBe(true);
        await vi.waitFor(() =>
          expect(manager.getTask(first)?.status, manager.getTask(first)?.error).toBe('completed'),
        );
        const resumed = (await readArchiveFile(path, format)).archive;
        expect(resumed.records).toHaveLength(before.records.length);
        expect(resumed.observations).toHaveLength(before.observations.length * 3);
        expect((await readdir(root)).some((name) => name.startsWith('.weq-update-'))).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
