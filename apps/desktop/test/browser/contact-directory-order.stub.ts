const config = { uin: '99999', configId: 'contact-order-fixture' };
const snapshot = {
  revision: 1,
  rows: {
    'friend:10001': { level: { value: 10, state: 'ready', attemptedAt: 1 } },
    'friend:10002': { level: { value: 20, state: 'ready', attemptedAt: 1 } },
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
