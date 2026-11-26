import { expect, it } from 'vitest';
import type { StorageUsageItem } from '@weq/service';
import { groupStorageEntries, mergeStorageEntries } from '../src/renderer/src/lib/storage-entries';
import { resolveSettingsTarget } from '../src/renderer/src/components/settings/navigation';

const base: StorageUsageItem = {
  id: 'base',
  path: '/synthetic/base',
  label: '合成数据',
  bytes: 1,
  clearable: false,
  incomplete: false,
  reason: '保留',
};
it('同一用途合计占用并保留每个来源和不完整状态', () => {
  const sources = [
    { ...base, id: 'one', path: '/first/history', label: '联系人信息缓存', bytes: 10 },
    {
      ...base,
      id: 'two',
      path: '/second/history',
      label: '联系人信息缓存',
      bytes: 20,
      incomplete: true,
    },
  ];
  const entries = mergeStorageEntries(sources);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    item: { bytes: 30, incomplete: true },
    members: sources,
  });
});
it('系统杂项隐藏，未知项目保留来源供定位', () => {
  const items = mergeStorageEntries([
    { ...base, id: 'ds', path: '/synthetic/.DS_Store', bytes: 5 },
    { ...base, id: 'ini', path: String.raw`C:\WeQ\desktop.ini`, bytes: 6 },
    { ...base, id: 'unknown', path: '/synthetic/unknown.bin', category: 'unknown', bytes: 7 },
  ]);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    item: { label: '用途待确认的文件', bytes: 7, clearable: false },
    members: [{ path: '/synthetic/unknown.bin' }],
  });
});
it('同类缓存跨目录合并，桌面缓存合并为一项，空项目不显示', () => {
  const cache = { ...base, clearable: true, category: 'cache' as const, action: 'cache' as const };
  const items = [
    { ...cache, id: 'avatar', label: '头像缓存', path: '/current/avatar', bytes: 10 },
    { ...cache, id: 'old-avatar', label: '头像缓存（默认目录）', path: '/old/avatar', bytes: 20 },
    { ...cache, id: 'gpu', label: '桌面运行缓存', path: '/profile/GPUCache', bytes: 30 },
    { ...cache, id: 'code', label: '桌面运行缓存', path: '/profile/Code Cache', bytes: 40 },
    { ...cache, id: 'empty', path: '/empty', bytes: 0 },
  ];
  const entries = mergeStorageEntries(items);
  expect(entries).toHaveLength(2);
  expect(entries.find((entry) => entry.item.label === '头像缓存')).toMatchObject({
    item: { bytes: 30 },
    members: [items[0], items[1]],
  });
  expect(entries.find((entry) => entry.item.label === '桌面运行缓存')).toMatchObject({
    item: { bytes: 70 },
    members: [items[2], items[3]],
  });
  expect(mergeStorageEntries([{ ...base, path: '/empty', bytes: 0 }])).toEqual([]);
  expect(mergeStorageEntries([{ ...base, path: '/.DS_Store', bytes: 1 }])).toEqual([]);
});
it('数据库备份与不同损失说明的持久数据不合并，统计失败不能当作空项隐藏', () => {
  const entries = mergeStorageEntries([
    { ...base, id: 'backup1', clearable: true, category: 'db-backups', path: '/one/a.db' },
    { ...base, id: 'backup2', clearable: true, category: 'db-backups', path: '/two/a.db' },
    { ...base, id: 'ocr', clearable: true, category: 'persistent', confirmation: '丢失识别结果' },
    { ...base, id: 'clone', clearable: true, category: 'persistent', confirmation: '丢失克隆数据' },
    { ...base, id: 'unreadable', bytes: 0, incomplete: true },
  ]);
  expect(entries).toHaveLength(5);
});
it('零字节异常项和普通点文件仍可见', () => {
  const entries = mergeStorageEntries([
    { ...base, id: 'empty', path: '/synthetic/empty', bytes: 0 },
    { ...base, id: 'unreadable', path: '/synthetic/unreadable', bytes: 0, incomplete: true },
    { ...base, id: 'custom', path: '/synthetic/.custom', bytes: 1 },
  ]);
  expect(entries[0]?.members.map((item) => item.path)).toEqual([
    '/synthetic/unreadable',
    '/synthetic/.custom',
  ]);
  expect(entries[0]?.item.incomplete).toBe(true);
});
it('按组小计排序，其他数据置底，同量数据库备份按日期倒序', () => {
  const groups = groupStorageEntries([
    { ...base, id: 'unknown', category: 'unknown', bytes: 9999 },
    { ...base, id: 'media', category: 'media', bytes: 200 },
    { ...base, id: 'dress', category: 'dress', bytes: 300 },
    { ...base, id: 'repair', category: 'repair-history', bytes: 350, incomplete: true },
    { ...base, id: 'empty', category: 'updates', bytes: 0 },
    {
      ...base,
      id: 'old',
      category: 'db-backups',
      bytes: 1,
      backup: {
        account: 'synthetic',
        database: 'a.db',
        at: '2026-10-25T00:00:00Z',
        status: 'linked',
      },
    },
    {
      ...base,
      id: 'new',
      category: 'db-backups',
      bytes: 1,
      backup: {
        account: 'synthetic',
        database: 'a.db',
        at: '2026-11-05T00:00:00Z',
        status: 'linked',
      },
    },
  ]);
  expect(groups.map(({ id, bytes }) => [id, bytes])).toEqual([
    ['database', 352],
    ['appearance', 300],
    ['media', 200],
    ['other', 9999],
  ]);
  expect(groups[0]?.incomplete).toBe(true);
  expect(groups[0]?.entries.map(({ item }) => item.id)).toEqual(['repair', 'new', 'old']);
});
it('配置旧入口定位重置按钮，桌面缓存和空间清理定位存储页', () => {
  for (const item of ['账号与应用配置', '全局配置']) {
    expect(resolveSettingsTarget({ section: 'weq-storage', item })).toMatchObject({
      section: 'backup',
      settingId: 'weq-config-management',
    });
  }
  expect(resolveSettingsTarget({ section: 'backup', item: '桌面运行数据' })).toMatchObject({
    section: 'weq-storage',
    settingId: 'weq-space-cleanup',
  });
  expect(resolveSettingsTarget({ section: 'weq-storage', item: '空间清理' })).toMatchObject({
    section: 'weq-storage',
    settingId: 'weq-space-cleanup',
  });
});
