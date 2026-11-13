import type { StorageUsageItem } from '@weq/service';
import type { PreferencePatch } from '@weq/service/client-preferences';

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
    id: 'logs',
    path: '/synthetic/Application Support/WeQ/logs',
    label: '运行日志',
    bytes: 3.4 * 1024 ** 3,
    category: 'persistent',
    action: 'data',
    confirmation: '将删除运行日志，已发生问题的排查证据无法恢复。',
  },
  {
    ...base,
    id: 'models',
    path: '/synthetic/Application Support/WeQ/models',
    label: '本地模型',
    bytes: 902 * 1024 ** 2,
    category: 'persistent',
    clearable: false,
    reason: '由增强包管理',
  },
  {
    ...base,
    id: 'anti_recall',
    path: '/synthetic/cache/anti_recall',
    label: '防撤回配置',
    management: 'backup',
    clearable: false,
  },
  ...['Cache', 'Code Cache', 'GPUCache'].map(
    (name): StorageUsageItem => ({
      ...base,
      id: name,
      path: `/synthetic/profile/${name}`,
      label: '桌面运行缓存',
      category: 'cache',
      action: 'cache',
      requiresExit: true,
      confirmation: '仅删除桌面缓存，后续使用时会重新生成。',
    }),
  ),
  { ...base, id: 'empty', path: '/synthetic/empty', label: '空项目', category: 'media', bytes: 0 },
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
            data:
              path.at(-1) === 'listStorageUsage'
                ? storageItems
                : path.at(-1) === 'storageCleanupResult'
                  ? { cleared: ['one', 'two'], failed: [], freedBytes: 1.7 * 1024 ** 3 }
                  : undefined,
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
            ? async (patch: PreferencePatch) => {
                if (path.join('.') === 'clientState.patch') {
                  Object.assign(preferences, patch);
                  return { revision: ++revision, values: { ...preferences }, records: {} };
                }
                return { ok: true };
              }
            : proxy([...path, String(key)]),
  });
const preferences: PreferencePatch = {};
let revision = 0;
export const trpc = proxy();
export const client = proxy();
