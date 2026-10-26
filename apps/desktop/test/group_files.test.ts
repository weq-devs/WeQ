// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  canManageGroupFile,
  groupFileEntries,
  groupFileNameConflict,
  readGroupFileDrag,
  validateGroupFileName,
} from '../src/renderer/src/lib/groupFileManager';
import {
  formatFileTime,
  type GroupFileWire,
  type GroupFolderWire,
  type GroupFileListing,
} from '../src/renderer/src/lib/groupFile';
import {
  groupFileSelectedKeys,
  collectGroupFileSubtree,
  resolveGroupFileSelection,
} from '../src/renderer/src/lib/groupFileSelection';
import type { GroupFileEntry } from '../src/renderer/src/views/export/GroupFileExportLightbox';
import { pruneNestedSelection } from '../src/renderer/src/lib/fileSelection';

describe('group_file_manager', () => {
  const file: GroupFileWire = {
    fileId: 'a',
    fileName: '资料.txt',
    fileSize: 2,
    busId: 102,
    uploadedTime: 1,
    modifiedTime: 0,
    expireTime: 0,
    downloadedTimes: 0,
    uploaderUin: 10001,
    uploaderName: '甲',
    parentDirectory: '/',
  };

  const folder: GroupFolderWire = {
    folderId: 'd',
    folderName: '目录',
    parentDirectoryId: '/',
    totalFileCount: 1,
    createTime: 2,
    modifiedTime: 0,
    creatorUin: 10001,
    creatorName: '甲',
  };

  describe('群文件管理器逻辑', () => {
    it('群文件时间明确按北京时间显示，不依赖运行机时区，坏时间不导致整页崩溃', () => {
      vi.stubEnv('TZ', 'UTC');
      try {
        expect(formatFileTime(Date.parse('2026-10-21T00:00:00Z') / 1000)).toBe('2026-10-21 08:00');
        expect(formatFileTime(Number.MAX_VALUE)).toBe('');
      } finally {
        vi.unstubAllEnvs();
      }
    });
    it('文件夹优先，稳定排序和过滤保留真实身份', () => {
      const b = { ...file, fileId: 'b', fileName: '另一份.txt', fileSize: 8 };
      expect(groupFileEntries([file, b], [folder], '', 'size').map((e) => e.key)).toEqual([
        'folder:d',
        'file:b',
        'file:a',
      ]);
      expect(groupFileEntries([file, b], [folder], '资料', 'name').map((e) => e.key)).toEqual([
        'file:a',
      ]);
    });
    it('禁止空名称、路径及点目录；同名冲突不包含当前重命名对象', () => {
      for (const name of ['', ' ', '..', 'a/b', 'a\\b', 'a\0b'])
        expect(() => validateGroupFileName(name)).toThrow();
      expect(validateGroupFileName(' 新名称.txt ')).toBe('新名称.txt');
      const listing = { targetDirectory: '/', files: [file], folders: [folder] };
      expect(groupFileNameConflict('资料.txt', listing)).toBe(true);
      expect(groupFileNameConflict('资料.txt', listing, 'file:a')).toBe(false);
      expect(groupFileNameConflict('目录', listing)).toBe(true);
    });
    it('普通成员只能管理自己的文件，未知身份不默认放行', () => {
      expect(groupFileEntries([file, file], [], '', 'name')).toHaveLength(1);
      const entry = groupFileEntries([file], [folder], '', 'name');
      expect(canManageGroupFile(entry[1]!, false, '10001')).toBe(true);
      expect(canManageGroupFile(entry[0]!, false, '10001')).toBe(false);
      expect(canManageGroupFile(entry[1]!, false, null)).toBe(false);
    });
    it('内部拖拽只接受同账号同源同群同目录仍存在的文件，拒绝外来 JSON 与失效身份', () => {
      const identity = { groupId: 123, uin: '10001', configId: 'source-a', directory: '/' };
      const payload = { version: 1, ...identity, ids: ['a', 'a'] };
      expect(readGroupFileDrag(JSON.stringify(payload), identity, [file])).toEqual(['a']);
      for (const value of [
        '{}',
        'invalid',
        JSON.stringify({ ...payload, configId: 'source-b' }),
        JSON.stringify({ ...payload, groupId: 456 }),
        JSON.stringify({ ...payload, ids: ['unknown'] }),
      ])
        expect(() => readGroupFileDrag(value, identity, [file])).toThrow();
    });
  });
});

describe('group_file_selection', () => {
  const file = (id: string, path: string[]): GroupFileEntry => ({
    fileId: id,
    fileName: id,
    fileSize: 1,
    busId: 1,
    uploaderName: '',
    path,
  });

  const folder: GroupFolderWire = {
    folderId: 'folder-a',
    parentDirectoryId: '/',
    folderName: '目录甲',
    totalFileCount: 2,
    createTime: 0,
    modifiedTime: 0,
    creatorUin: 0,
    creatorName: '',
  };

  const listing: GroupFileListing = { targetDirectory: '/', folders: [folder], files: [] };

  describe('群文件范围选择', () => {
    it('共用子树遍历保留目录结构并防止目录环，错误目录或切源时停止', async () => {
      const load = vi.fn(
        async (directory: string): Promise<GroupFileListing> => ({
          targetDirectory: directory,
          files: [],
          folders:
            directory === 'folder-a'
              ? [{ ...folder, folderId: 'child', folderName: '子目录' }]
              : [{ ...folder, folderId: 'folder-a' }],
        }),
      );
      await collectGroupFileSubtree({ id: 'folder-a', path: ['目录甲'] }, load);
      expect(load.mock.calls.map((call) => call[0])).toEqual(['folder-a', 'child']);
      await expect(
        collectGroupFileSubtree({ id: 'folder-a', path: [] }, async () => ({
          ...listing,
          targetDirectory: 'other',
        })),
      ).rejects.toThrow('不一致');
      let current = true;
      await expect(
        collectGroupFileSubtree(
          { id: 'folder-a', path: [] },
          async () => {
            current = false;
            return { ...listing, targetDirectory: 'folder-a' };
          },
          () => current,
        ),
      ).rejects.toThrow('停止');
    });
    it('下载选择中目录覆盖其后代，但不误吞同前缀的兄弟目录', () => {
      const parent = { path: '/folder', isDir: true },
        child = { path: '/folder/child', isDir: false },
        sibling = { path: '/folder-other/file', isDir: false };
      expect([
        ...pruneNestedSelection(
          new Map([
            ['parent', parent],
            ['child', child],
            ['sibling', sibling],
          ]),
        ).keys(),
      ]).toEqual(['parent', 'sibling']);
    });
    it('Shift 范围只带文件夹键时也完整保留已有子树，不丢掉子文件', async () => {
      const files = [file('a', ['目录甲']), file('b', ['目录甲', '子目录'])];
      const selected = new Map(files.map((item) => [item.fileId, item]));
      const cache = new Map([[folder.folderId, files]]);
      expect(groupFileSelectedKeys(selected, [folder], cache).has('folder:folder-a')).toBe(true);
      const load = vi.fn();
      const next = await resolveGroupFileSelection({
        keys: new Set(['folder:folder-a']),
        selected,
        listing,
        path: [],
        cache,
        load,
      });
      expect([...next.keys()]).toEqual(['a', 'b']);
      expect(load).not.toHaveBeenCalled();
    });
    it('取消整个文件夹时移除真实子树，不影响其它目录的已选文件', async () => {
      const a = file('a', ['目录甲']),
        outside = file('outside', ['其它目录']);
      const next = await resolveGroupFileSelection({
        keys: new Set(['file:a', 'file:outside']),
        selected: new Map([
          ['a', a],
          ['outside', outside],
        ]),
        listing,
        path: [],
        cache: new Map([[folder.folderId, [a]]]),
        load: vi.fn(),
      });
      expect([...next.keys()]).toEqual(['outside']);
    });
    it('未缓存目录经现有加载器取得真实文件；清空不执行目录读取', async () => {
      const load = vi.fn(async () => [file('a', ['目录甲'])]);
      const input = {
        selected: new Map<string, GroupFileEntry>(),
        listing,
        path: [],
        cache: new Map<string, GroupFileEntry[]>(),
        load,
      };
      expect([
        ...(
          await resolveGroupFileSelection({ ...input, keys: new Set(['folder:folder-a']) })
        ).keys(),
      ]).toEqual(['a']);
      load.mockClear();
      expect((await resolveGroupFileSelection({ ...input, keys: new Set() })).size).toBe(0);
      expect(load).not.toHaveBeenCalled();
    });
  });
});
