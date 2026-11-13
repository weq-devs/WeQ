const proxy = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, key) => {
      if (key === 'useQuery') return () => ({ data: undefined, isLoading: false });
      if (key === 'useInfiniteQuery')
        return () => ({ data: { pages: [{ items: [] }] }, isLoading: false });
      return proxy();
    },
  });
export const trpc = proxy();
export const client = proxy();
