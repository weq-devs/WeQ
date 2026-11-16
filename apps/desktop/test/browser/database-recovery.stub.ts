function proxy(path = ''): unknown {
  return new Proxy(() => {}, {
    apply: () => proxy(path),
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({
          data: path.endsWith('getAccountConfig')
            ? { uin: '10001', configId: 'recovery-fixture' }
            : {},
          isFetching: false,
          isLoading: false,
          isError: false,
          error: null,
        });
      if (key === 'useMutation') return () => ({ isPending: false, mutateAsync: async () => ({}) });
      if (key === 'useSubscription') return () => {};
      if (key === 'then') return undefined;
      if (key === 'query' || key === 'fetch') return async () => ({});
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
