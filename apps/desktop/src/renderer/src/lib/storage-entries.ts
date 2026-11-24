import type { StorageUsageItem } from '@weq/service';

const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

const GROUP_LABELS = {
  media: '媒体、头像与预览',
  appearance: '表情、装扮与背景',
  conversations: '聊天记录与联系人',
  work: '草稿、导出与任务',
  search: '搜索与内容识别',
  assistant: '助手、克隆与用量',
  database: '数据库备份与维护',
  qq: '托管 QQ',
  resources: '应用资源与模型',
  desktop: '桌面运行与更新',
  diagnostics: '日志与诊断',
  other: '其他数据',
};

type StorageGroupId = keyof typeof GROUP_LABELS;
const CATEGORY_GROUPS: Record<NonNullable<StorageUsageItem['category']>, StorageGroupId> = {
  media: 'media',
  dress: 'appearance',
  'account-data': 'conversations',
  'work-products': 'work',
  'search-analysis': 'search',
  'assistant-data': 'assistant',
  'db-backups': 'database',
  'database-validation': 'database',
  'repair-history': 'database',
  'repair-work': 'database',
  'managed-qq': 'qq',
  'app-resources': 'resources',
  cache: 'desktop',
  'desktop-data': 'desktop',
  updates: 'desktop',
  'program-backups': 'desktop',
  diagnostics: 'diagnostics',
  persistent: 'other',
  unknown: 'other',
};

type StorageEntry = { item: StorageUsageItem; members: StorageUsageItem[] };
type StorageGroup = {
  id: StorageGroupId;
  entries: StorageEntry[];
  bytes: number;
  incomplete: boolean;
};

/** 把同一用途、同一清理影响的来源汇成一行，保留每个来源的定位和清理 ID。 */
export function mergeStorageEntries(items: readonly StorageUsageItem[]) {
  const entries = new Map<string, StorageEntry>();
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

/** 同组按项目占用排序，组间按小计排序，未归类数据放在末尾。 */
export function groupStorageEntries(items: readonly StorageUsageItem[]) {
  const groups = new Map<StorageGroupId, StorageGroup>();
  for (const entry of mergeStorageEntries(items)) {
    const { item } = entry;
    const id = item.category
      ? CATEGORY_GROUPS[item.category]
      : item.action === 'cache' || (item.clearable && !item.action && !item.requiresExit)
        ? 'desktop'
        : 'other';
    const group = groups.get(id) ?? { id, entries: [], bytes: 0, incomplete: false };
    group.entries.push(entry);
    group.bytes += item.bytes;
    group.incomplete ||= item.incomplete;
    groups.set(id, group);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        Number(a.id === 'other') - Number(b.id === 'other') ||
        b.bytes - a.bytes ||
        a.id.localeCompare(b.id),
    )
    .map((group) => ({ ...group, label: GROUP_LABELS[group.id] }));
}
