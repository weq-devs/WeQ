interface StorageEntry {
  path: string;
  bytes: number;
  incomplete: boolean;
  clearable: boolean;
}

const GROUPS = [
  { label: '本地模型', names: ['models'] },
  {
    label: '消息与搜索数据',
    names: [
      'ocr',
      'search-index',
      'content-search',
      'roam-msg',
      'roaming-jobs',
      'collection-history',
      'deleted',
      'anti_recall',
    ],
  },
  { label: '助手与智能分析', names: ['agentlab', 'weq-assistant', 'api_usage', 'intent_sense'] },
  { label: '导出与文件', names: ['export', 'web-exports', 'merge-forward', 'flash'] },
  {
    label: '装扮与表情资源',
    names: ['dress', 'dress_shared', 'qqshow', 'marketface', 'marketpack', 'sysemoji'],
  },
  { label: '配置与日志', names: ['config', 'config.json', 'logs', 'remote-network'] },
] as const;

const SYSTEM_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

/** 只整理展示；不改变原始清理 ID、权限或总占用，未知文件仍可展开查看。 */
export function groupRetainedStorage<T extends StorageEntry>(items: readonly T[]) {
  const groups = GROUPS.map(({ label }) => ({
    label,
    items: [] as T[],
    bytes: 0,
    incomplete: false,
  }));
  const other = { label: '应用运行与其他数据', items: [] as T[], bytes: 0, incomplete: false };
  for (const item of items) {
    if (item.clearable) continue;
    const name = item.path.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
    const index = GROUPS.findIndex((group) => group.names.some((entry) => entry === name));
    const group = groups[index] ?? other;
    group.bytes += item.bytes;
    group.incomplete ||= item.incomplete;
    if (!SYSTEM_FILES.has(name.toLowerCase()) && (item.bytes > 0 || item.incomplete)) {
      group.items.push(item);
    }
  }
  return [...groups, other].filter((group) => group.bytes > 0 || group.incomplete);
}
