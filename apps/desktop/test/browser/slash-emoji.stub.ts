const catalog = {
  faces: [
    { id: '14', desc: '[微笑]' },
    { id: '9', desc: '/笑哭' },
    ...Array.from({ length: 10 }, (_, index) => ({
      id: String(20 + index),
      desc: `合成表情${index}`,
    })),
  ],
  recent: [],
};
const account = { uin: '26113', configId: 'fixture' };
const proxy = (path = ''): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) =>
      key === 'useQuery'
        ? () => ({
            data: path.endsWith('shortcuts')
              ? catalog
              : path.endsWith('getAccountConfig')
                ? account
                : undefined,
            isLoading: false,
            isFetching: false,
          })
        : key === 'useMutation'
          ? () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false })
          : ['query', 'fetch', 'invalidate'].includes(String(key))
            ? async () => undefined
            : proxy(`${path}.${String(key)}`),
  });
export const trpc = proxy();
export const client = proxy();
