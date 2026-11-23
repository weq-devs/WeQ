export const rpcFixture = new Map<string, () => unknown>();

const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) =>
      rpcFixture.get([...path, String(key)].join('.')) ??
      (key === '_def'
        ? () => ({ path })
        : key === 'useQueries'
          ? () => []
          : key === 'useQuery'
            ? () => ({
                data: undefined,
                isLoading: false,
                isFetching: false,
                refetch: async () => ({ data: undefined }),
              })
            : key === 'useMutation'
              ? () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false })
              : key === 'query' || key === 'fetch' || key === 'invalidate'
                ? async () => undefined
                : key === 'subscribe'
                  ? () => ({ unsubscribe() {} })
                  : proxy([...path, String(key)])),
  });
export const trpc = proxy();
export const client = proxy();
