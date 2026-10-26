const proxy = (): unknown =>
  new Proxy(() => proxy(), {
    get: (_target, key) =>
      key === 'useQuery'
        ? () => ({ data: undefined, isLoading: false, isFetching: false })
        : key === 'useMutation'
          ? () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false })
          : key === 'query' || key === 'fetch' || key === 'invalidate'
            ? async () => undefined
            : key === 'subscribe'
              ? () => ({ unsubscribe() {} })
              : proxy(),
  });
export const trpc = proxy();
export const client = proxy();
