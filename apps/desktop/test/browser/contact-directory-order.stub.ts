const config = { uin: '99999', configId: 'contact-order-fixture' };
const ready = (value: unknown) => ({
  value,
  state: 'ready',
  attemptedAt: 1,
  updatedAt: Date.now(),
});
const snapshot = {
  revision: 1,
  rows: {
    'friend:10001': {
      level: ready(10),
      likeCount: ready(12580),
      commonFriends: ready(12),
      commonGroups: ready([]),
      addedAt: ready(Date.UTC(2022, 7, 31, 16, 30) / 1000),
    },
    'friend:10002': {
      level: { ...ready(20), state: 'stale' },
      likeCount: ready(0),
      commonFriends: ready(0),
      commonGroups: ready([{ groupCode: '20001', name: '学习交流' }]),
      addedAt: ready(1600000000),
    },
    'friend:10003': {
      level: { state: 'failed', attemptedAt: 1, updatedAt: Date.now(), error: '合成读取失败' },
    },
    'group:20001': { activityScore: ready(78), friendCount: ready(2) },
    'group:20002': { activityScore: ready(0), friendCount: ready(0) },
    'group:20003': {
      activityScore: { state: 'failed', attemptedAt: 1, updatedAt: Date.now() },
      friendCount: ready(3),
    },
  },
  progress: {
    status: new URLSearchParams(location.search).get('progress') ?? 'completed',
    done: 2,
    total: 6,
    failed: 0,
    phase: '',
  },
};
const regions = [
  { code: '1', name: '中国', children: [{ code: '35', name: '福建', children: [] }] },
  { code: '2', name: '美国', children: [] },
];
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useUtils') return () => proxy();
      if (key === 'useSubscription') return () => undefined;
      if (key === 'useQuery')
        return () => ({
          data:
            path.join('.') === 'account.getAccountConfig'
              ? config
              : path.join('.') === 'account.contactMetrics.snapshot'
                ? snapshot
                : path.join('.') === 'account.qqWrite.profileRegions'
                  ? { regions }
                  : undefined,
          isLoading: false,
          refetch: async () => ({ data: undefined }),
        });
      if (key === 'useMutation')
        return () => ({
          mutate: () => {},
          mutateAsync: async () => 'synthetic-task',
          isLoading: false,
        });
      if (key === 'invalidate' || key === 'query' || key === 'fetch') return async () => undefined;
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
