const values: Record<string, unknown> = {
  'account.getAccountConfig': { uin: '10001', configId: 'button-fixture' },
  'bootstrap.getSettings': { realtimeEnabled: true, autoAttachQq: true, dbReadConcurrency: 4 },
};

function proxy(path = ''): unknown {
  return new Proxy(() => {}, {
    apply: () => proxy(path),
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({
          data: values[path],
          error: null,
          isLoading: false,
          isFetching: false,
          isError: false,
          refetch: async () => ({ data: values[path] }),
        });
      if (key === 'useMutation')
        return () => ({ isLoading: false, mutateAsync: async () => undefined, mutate: () => {} });
      if (key === 'useSubscription') return () => {};
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      if (key === 'then') return undefined;
      if (['invalidate', 'query', 'fetch', 'mutate'].includes(String(key)))
        return async () => values[path];
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
