import type { StorageUsageItem } from '@weq/service';

const base = {
  bytes: 2048,
  incomplete: false,
  clearable: true,
  reason: '按需重新下载',
  management: 'cleanup' as const,
};
export const storageItems: StorageUsageItem[] = [
  {
    ...base,
    id: 'media',
    path: '/synthetic/cache/media',
    label: '图片与视频缓存',
    bytes: 1024 ** 3,
    category: 'media',
    action: 'cache',
  },
  {
    ...base,
    id: 'backup',
    path: '/synthetic/cache/db_repair/account/backups/first',
    label: '合成账号 · nt_msg.db',
    category: 'db-backups',
    action: 'db-backup',
    requiresExit: true,
    backup: {
      account: '合成账号',
      database: 'nt_msg.db',
      at: '2026-11-05T00:00:00Z',
      status: 'linked',
    },
    confirmation: '只删除备份，保留修复记录与报告；不能再用于回滚。',
  },
  {
    ...base,
    id: 'dress',
    path: '/synthetic/cache/dress_shared',
    label: '共享装扮资源缓存',
    category: 'dress',
    action: 'cache',
  },
  {
    ...base,
    id: 'history',
    path: '/synthetic/cache/db_repair/account/history.json',
    label: '数据库修复记录与报告',
    category: 'repair-history',
    management: 'repair',
    clearable: false,
  },
  {
    ...base,
    id: 'unknown',
    path: '/synthetic/a-very-long-directory-name-containing-unknown-data/unknown-file-with-a-long-name.bin',
    label: '未识别数据',
    category: 'unknown',
    clearable: false,
  },
  {
    ...base,
    id: 'program',
    path: '/synthetic/repair-backups/sql-deadline-20261025',
    label: '历史程序修补备份 · sql-deadline-20261025',
    category: 'program-backups',
    action: 'program-backup',
    requiresExit: true,
  },
  {
    ...base,
    id: 'config',
    path: '/synthetic/config',
    label: '账号与应用配置',
    management: 'backup',
    action: 'data',
    requiresExit: true,
    confirmation: '将删除账号配置，需要重新配置或登录。',
  },
];
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) =>
      key === 'useQuery'
        ? () => ({
            data: path.at(-1) === 'listStorageUsage' ? storageItems : undefined,
            isLoading: false,
            isFetching: false,
            refetch: async () => ({}),
          })
        : key === 'useMutation'
          ? () => ({
              mutateAsync: async () => ({ cleared: [], failed: [], freedBytes: 0, restartIds: [] }),
              isLoading: false,
            })
          : key === 'mutate'
            ? async () => ({ ok: true })
            : proxy([...path, String(key)]),
  });
export const trpc = proxy();
export const client = proxy();
