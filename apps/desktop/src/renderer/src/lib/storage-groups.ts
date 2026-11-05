import type { StorageUsageItem } from '@weq/service';

const LABELS = {
  'db-backups': '历史数据库备份',
  media: '图片、视频与媒体缓存',
  dress: '表情与装扮缓存',
  cache: '其他可再生成缓存',
  persistent: '持久数据',
  'program-backups': '历史程序修补备份',
  'repair-history': '数据库修复记录与报告',
  'repair-work': '数据库修复临时文件',
  unknown: '其他已占用数据',
} as const;

const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/** 使用服务端业务分类；旧清单只提供保守展示，不通过路径猜测删除能力。 */
export function groupStorage(items: readonly StorageUsageItem[], backupManagement = false) {
  const groups = new Map<
    string,
    { key: string; label: string; items: StorageUsageItem[]; bytes: number; incomplete: boolean }
  >();
  for (const item of items) {
    const key =
      item.category ?? (item.clearable ? (item.requiresExit ? 'persistent' : 'cache') : 'unknown');
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: backupManagement ? '配置与运行数据管理' : LABELS[key],
        items: [],
        bytes: 0,
        incomplete: false,
      };
      groups.set(key, group);
    }
    group.bytes += item.bytes;
    group.incomplete ||= item.incomplete;
    const name = item.path.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
    if (!SYSTEM_FILES.has(name) && (item.bytes > 0 || item.incomplete)) group.items.push(item);
  }
  for (const group of groups.values())
    group.items.sort(
      (a, b) =>
        b.bytes - a.bytes ||
        (b.backup?.at ?? '').localeCompare(a.backup?.at ?? '') ||
        a.id.localeCompare(b.id),
    );
  return [...groups.values()]
    .filter((group) => group.bytes > 0 || group.incomplete)
    .sort((a, b) => {
      if (a.key === b.key) return 0;
      if (a.key === 'db-backups' || b.key === 'unknown') return -1;
      if (b.key === 'db-backups' || a.key === 'unknown') return 1;
      return b.bytes - a.bytes || a.key.localeCompare(b.key);
    });
}
