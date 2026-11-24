import type { StorageUsageItem } from '@weq/service';

const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/** 把同一用途、同一清理影响的来源汇成一行，保留每个来源的定位和清理 ID。 */
export function mergeStorageEntries(items: readonly StorageUsageItem[]) {
  const entries = new Map<string, { item: StorageUsageItem; members: StorageUsageItem[] }>();
  for (const item of items) {
    const name = item.path.split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
    if (SYSTEM_FILES.has(name) || (item.bytes === 0 && !item.incomplete)) continue;
    const label = item.backup
      ? `数据库备份 · ${item.backup.account} · ${item.backup.database}`
      : item.category === 'unknown'
        ? '用途待确认的文件'
        : item.label.replace(/（默认目录）$/, '');
    const key =
      item.category === 'db-backups' || item.category === 'program-backups' || item.backup
        ? item.id
        : JSON.stringify([
            item.category,
            item.action,
            item.management,
            item.clearable,
            item.exitOnly,
            item.confirmation,
            item.clearable ? undefined : item.reason,
            label,
          ]);
    const entry = entries.get(key);
    if (entry) {
      entry.members.push(item);
      entry.item.bytes += item.bytes;
      entry.item.incomplete ||= item.incomplete;
      entry.item.requiresExit ||= item.requiresExit;
    } else entries.set(key, { item: { ...item, label }, members: [item] });
  }
  return [...entries.values()].sort(
    (a, b) =>
      b.item.bytes - a.item.bytes ||
      (b.item.backup?.at ?? '').localeCompare(a.item.backup?.at ?? '') ||
      a.item.id.localeCompare(b.item.id),
  );
}
