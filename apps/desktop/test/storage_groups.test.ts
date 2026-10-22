import { describe, expect, it } from 'vitest';
import { groupRetainedStorage } from '../src/renderer/src/lib/storage-groups';

function item(name: string, bytes = 10, incomplete = false) {
  return { path: `/synthetic/${name}`, bytes, incomplete, clearable: false };
}

describe('存储管理分类', () => {
  it('合并相关数据，保留原始明细和不完整标记', () => {
    const items = [item('search-index'), item('roam-msg', 20, true), item('models', 30)];
    const groups = groupRetainedStorage(items);
    expect(groups.find((group) => group.label === '消息与搜索数据')).toMatchObject({
      bytes: 30,
      incomplete: true,
      items: items.slice(0, 2),
    });
    expect(groups.find((group) => group.label === '本地模型')?.bytes).toBe(30);
    expect(groups.reduce((sum, group) => sum + group.bytes, 0)).toBe(60);
  });

  it('系统杂项不单列但仍计入占用，未知数据保留且不提升清理权限', () => {
    const items = [item('.DS_Store', 5), item('desktop.ini', 6), item('unknown.bin', 7)];
    const groups = groupRetainedStorage(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ bytes: 18, items: [items[2]] });
    expect(groups[0].items[0].clearable).toBe(false);
  });

  it('兼容 Windows 路径，不隐藏零字节异常项，也不隐藏普通点文件', () => {
    const groups = groupRetainedStorage([
      { ...item('config.json'), path: 'C:\\WeQ\\config.json' },
      item('empty', 0),
      item('unreadable', 0, true),
      item('.custom', 1),
      { ...item('avatar'), clearable: true },
    ]);
    expect(groups.find((group) => group.label === '配置与日志')?.bytes).toBe(10);
    const runtime = groups.find((group) => group.label === '应用运行与其他数据')!;
    expect(runtime.items.map((entry) => entry.path)).toEqual([
      '/synthetic/unreadable',
      '/synthetic/.custom',
    ]);
    expect(runtime.incomplete).toBe(true);
  });
});
