import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';
import { readArchive } from '../src/account/export/archive';
import { withExportSaveDirectory } from './support/export_save_fixture';
import type { CollectionExportRow } from '../src/account/export/collection_export';

it('收藏暂停后重启管理器可按原 CID 继续，恢复到收藏流水线而非聊天消息源', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-collection-resume-'));
  const row: CollectionExportRow = {
    cid: 'selected',
    kind: 'text',
    type: 1,
    createTime: 1000,
    collectTime: 1000,
    authorName: '',
    authorUin: '',
    groupName: '',
    text: '合成收藏',
    link: null,
    gallery: null,
    audio: null,
    video: null,
    file: null,
    location: null,
    richMedia: null,
  };
  const deps = withExportSaveDirectory(root, {
    collection: { listCollections: async () => [row] },
  });
  try {
    const manager = new ExportTaskManager({} as MsgService, root, deps);
    let paused = false;
    manager.on('progress', (event) => {
      if (!paused && event.status === 'running') {
        paused = true;
        manager.pauseTask(event.taskId);
      }
    });
    const id = await manager.startTask({
      kind: 'c2c',
      conv: 'collections',
      name: '合成收藏',
      format: 'json',
      total: 1,
      collection: { cids: ['selected'] },
    });
    await vi.waitFor(() => expect(manager.listTasks()[0]?.canResume).toBe(true));
    expect(manager.getTask(id)?.status).toBe('paused');
    const restored = new ExportTaskManager({} as MsgService, root, deps);
    expect(restored.resumeTask(id)).toBe(true);
    await vi.waitFor(() => expect(restored.getTask(id)?.status).toBe('completed'));
    expect(restored.getTask(id)?.error).toBeUndefined();
    const task = restored.getTask(id)!;
    const archive = readArchive(JSON.parse(readFileSync(task.filePath!, 'utf8')));
    expect(archive.records.map((record) => record.data.cid)).toEqual(['selected']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['json', 'jsonl'] as const)(
  '收藏 %s 增量直接更新已保存归档，保留旧版本和范围，删除任务不删除正式结果',
  async (format) => {
    const root = mkdtempSync(join(tmpdir(), 'weq-collection-update-'));
    const row: CollectionExportRow = {
      cid: 'first',
      kind: 'text',
      type: 1,
      createTime: 1000,
      collectTime: 1000,
      authorName: '',
      authorUin: '',
      groupName: '',
      text: '第一版',
      link: null,
      gallery: null,
      audio: null,
      video: null,
      file: null,
      location: null,
      richMedia: null,
    };
    let rows = [row];
    const manager = new ExportTaskManager(
      {} as MsgService,
      root,
      withExportSaveDirectory(root, { collection: { listCollections: async () => rows } }),
    );
    try {
      const id = await manager.startTask({
        kind: 'c2c',
        conv: 'collections',
        name: '合成收藏',
        format,
        total: 1,
        collection: {},
      });
      await vi.waitFor(() => expect(manager.getTask(id)?.save?.status).toBe('saved'));
      const task = manager.getTask(id)!;
      const saved = task.save!.path!;
      const path = join(saved, `合成收藏.${format}`);
      const prefix = readFileSync(path, 'utf8');
      const { readArchiveFile } = await import('../src/account/export/archive');
      const original = (await readArchiveFile(path, format)).archive;
      rows = [
        { ...row, text: '第二版' },
        { ...row, cid: 'late', text: '晚到内容' },
      ];
      const names = readdirSync(dirname(saved));
      expect(manager.listTasks()[0]?.canIncremental).toBe(true);
      expect(manager.resumeTask(id, true)).toBe(true);
      await vi.waitFor(() => expect(manager.getTask(id)?.status).toBe('completed'));
      expect(manager.getTask(id)?.error).toBeUndefined();
      expect(task.filePath).toBe(path);
      expect(task.save?.path).toBe(saved);
      const updated = (await readArchiveFile(path, format)).archive;
      expect(updated.archiveId).toBe(original.archiveId);
      expect(updated.records).toHaveLength(3);
      if (format === 'jsonl') expect(readFileSync(path, 'utf8').startsWith(prefix)).toBe(true);
      expect(readdirSync(dirname(saved))).toEqual(names);
      expect(manager.deleteTask(id)).toBe(true);
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
