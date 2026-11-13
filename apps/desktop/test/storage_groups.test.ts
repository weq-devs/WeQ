import { expect, it } from 'vitest';
import type { StorageUsageItem } from '@weq/service';
import { groupStorage, mergeStorageEntries } from '../src/renderer/src/lib/storage-groups';
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
it('同类数据保留原始明细和不完整标记，统计总量不变', () => {
  const items = [
    { ...base, id: 'search', category: 'persistent' as const, bytes: 10 },
    { ...base, id: 'roam', category: 'persistent' as const, bytes: 20, incomplete: true },
    { ...base, id: 'media', category: 'media' as const, bytes: 30 },
  ];
  const groups = groupStorage(items);
  expect(groups.find((group) => group.key === 'persistent')).toMatchObject({
    bytes: 30,
    incomplete: true,
    items: [items[1], items[0]],
  });
  expect(groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(60);
});
it('系统杂项不单列但占用仍累计，未知项不提升清理权限', () => {
  const groups = groupStorage([
    { ...base, path: '/synthetic/.DS_Store', bytes: 5 },
    { ...base, path: 'C:\\WeQ\\desktop.ini', bytes: 6 },
    { ...base, path: '/synthetic/unknown.bin', bytes: 7 },
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0]?.bytes).toBe(18);
  expect(groups[0]?.items.map((item) => item.path)).toEqual(['/synthetic/unknown.bin']);
  expect(groups[0]?.items[0]?.clearable).toBe(false);
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
  expect(groupStorage([{ ...base, path: '/empty', bytes: 0 }])).toEqual([]);
  expect(groupStorage([{ ...base, path: '/.DS_Store', bytes: 1 }])).toEqual([]);
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
it('兼容 Windows 路径，零字节异常项和普通点文件仍可见', () => {
  const groups = groupStorage([
    { ...base, path: 'C:\\WeQ\\config.json', bytes: 10 },
    { ...base, path: '/synthetic/empty', bytes: 0 },
    { ...base, path: '/synthetic/unreadable', bytes: 0, incomplete: true },
    { ...base, path: '/synthetic/.custom', bytes: 1 },
  ]);
  expect(groups[0]?.items.map((item) => item.path)).toEqual([
    'C:\\WeQ\\config.json',
    '/synthetic/.custom',
    '/synthetic/unreadable',
  ]);
  expect(groups[0]?.incomplete).toBe(true);
});
it('数据库备份固定置顶，未知项固定置底，其余分类和条目按占用排序，同量备份按日期倒序', () => {
  const groups = groupStorage([
    { ...base, id: 'unknown', category: 'unknown', bytes: 9999 },
    { ...base, id: 'media', category: 'media', bytes: 200 },
    { ...base, id: 'dress', category: 'dress', bytes: 300 },
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
  expect(groups.map((group) => group.key)).toEqual(['db-backups', 'dress', 'media', 'unknown']);
  expect(groups[0]?.items.map((item) => item.id)).toEqual(['new', 'old']);
});
it('配置旧入口定位重置按钮，桌面缓存和空间清理定位存储页', () => {
  for (const item of ['账号与应用配置', '全局配置']) {
    expect(resolveSettingsTarget({ section: 'weq-storage', item })).toMatchObject({
      section: 'startup',
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
