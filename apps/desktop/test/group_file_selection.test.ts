import { describe, expect, it, vi } from 'vitest';
import {
  groupFileSelectedKeys,
  collectGroupFileSubtree,
  resolveGroupFileSelection,
} from '../src/renderer/src/lib/groupFileSelection';
import type { GroupFileEntry } from '../src/renderer/src/views/export/GroupFileExportLightbox';
import type { GroupFileListing, GroupFolderWire } from '../src/renderer/src/lib/groupFile';
import { pruneNestedSelection } from '../src/renderer/src/lib/fileSelection';

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
      ...(await resolveGroupFileSelection({ ...input, keys: new Set(['folder:folder-a']) })).keys(),
    ]).toEqual(['a']);
    load.mockClear();
    expect((await resolveGroupFileSelection({ ...input, keys: new Set() })).size).toBe(0);
    expect(load).not.toHaveBeenCalled();
  });
});
