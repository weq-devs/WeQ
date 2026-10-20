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
} from '../src/renderer/src/lib/groupFile';
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
