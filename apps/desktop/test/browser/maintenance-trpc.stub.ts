export const maintenanceCalls: Array<{ ids: string[]; afterExit?: boolean }> = [];
const items = [
  {
    id: 'avatar',
    label: '头像缓存',
    path: '/synthetic/cache/avatar',
    bytes: 1024,
    clearable: true,
    reason: '按需下载',
    incomplete: false,
  },
  {
    id: 'db_repair',
    label: '数据库修复备份',
    path: '/synthetic/cache/db_repair',
    bytes: 2048,
    clearable: true,
    requiresExit: true,
    reason: '需确认',
    confirmation: '清除后失去回滚能力。',
    incomplete: false,
  },
  {
    id: 'agentlab',
    label: '克隆数据',
    path: '/synthetic/cache/agentlab',
    bytes: 4096,
    clearable: true,
    requiresExit: true,
    reason: '需确认',
    confirmation: '清除克隆对话与记忆。',
    incomplete: false,
  },
];
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) =>
      key === 'useQuery'
        ? () => ({
            data: path.at(-1) === 'listStorageUsage' ? items : undefined,
            isLoading: false,
            isFetching: false,
            refetch: async () => ({ data: items }),
          })
        : key === 'useMutation'
          ? () => ({
              isLoading: false,
              mutateAsync: async (input: { ids: string[]; afterExit?: boolean }) => {
                maintenanceCalls.push(input);
                const busy = !input.afterExit && input.ids.includes('agentlab');
                return {
                  scheduled: Boolean(input.afterExit),
                  freedBytes: 1024,
                  cleared: input.ids.filter((id) => !busy || id !== 'agentlab'),
                  failed: busy
                    ? [
                        {
                          id: 'agentlab',
                          label: '克隆数据',
                          error: '当前运行实例占用',
                          retryAfterRestart: true,
                        },
                      ]
                    : [],
                  restartIds: busy ? ['agentlab'] : [],
                };
              },
            })
          : key === 'subscribe'
            ? () => ({ unsubscribe() {} })
            : proxy([...path, String(key)]),
  });
export const trpc = proxy();
export const client = proxy();
