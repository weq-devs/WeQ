import { expect, it } from 'vitest';
import type { StorageUsageItem } from '@weq/service';
import { groupStorage } from '../src/renderer/src/lib/storage-groups';
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
it('配置与运行状态相关旧入口定位备份与恢复，空间清理仍定位原页', () => {
  for (const item of ['账号与应用配置', '全局配置', '桌面运行数据', '远程连接状态']) {
    expect(resolveSettingsTarget({ section: 'weq-storage', item })).toMatchObject({
      section: 'backup',
      settingId: 'weq-config-management',
    });
  }
  expect(resolveSettingsTarget({ section: 'weq-storage', item: '空间清理' })).toMatchObject({
    section: 'weq-storage',
    settingId: 'weq-space-cleanup',
  });
});
