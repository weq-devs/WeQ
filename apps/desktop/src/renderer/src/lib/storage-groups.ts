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

/** 合并展示但保留原始目标；清理仍逐项交给宿主核验。 */
export function mergeStorageEntries(items: readonly StorageUsageItem[]) {
  const entries = new Map<string, { item: StorageUsageItem; members: StorageUsageItem[] }>();
  for (const item of items) {
    if (item.bytes === 0 && !item.incomplete) continue;
    const label = item.label.replace(/（默认目录）$/, '');
    const mergeable =
      item.clearable &&
      !item.backup &&
      item.category !== 'db-backups' &&
      item.category !== 'program-backups' &&
      (item.action === 'cache' || item.action === 'data' || (!item.action && !item.requiresExit));
    const key = mergeable
      ? JSON.stringify([item.category, item.action, item.cleanupKind, label, item.confirmation])
      : item.id;
    const entry = entries.get(key);
    if (entry) {
      entry.members.push(item);
      entry.item.bytes += item.bytes;
      entry.item.incomplete ||= item.incomplete;
      entry.item.requiresExit ||= item.requiresExit;
    } else entries.set(key, { item: { ...item, label }, members: [item] });
  }
  return [...entries.values()].sort((a, b) => b.item.bytes - a.item.bytes);
}

/** 使用服务端业务分类；旧清单只提供保守展示，不通过路径猜测删除能力。 */
export function groupStorage(items: readonly StorageUsageItem[]) {
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
        label: LABELS[key],
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
    .filter((group) => group.items.length > 0)
    .sort((a, b) => {
      if (a.key === b.key) return 0;
      if (a.key === 'db-backups' || b.key === 'unknown') return -1;
      if (b.key === 'db-backups' || a.key === 'unknown') return 1;
      return b.bytes - a.bytes || a.key.localeCompare(b.key);
    });
}
