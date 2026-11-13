const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const params = new URLSearchParams(location.search);
export const favoriteRequests: Array<{ url: string }> = [];
export const favoriteInvalidations: string[] = [];
let ids: string[] = [];
const data: Record<string, unknown> = {
  'account.getAccountConfig': { uin: '10001', configId: 'fixture' },
  'account.getGroupAlbumAccessState': {
    qqOnline: !params.has('offline'),
    attachEnabled: true,
    hasA2: true,
    hasD2: true,
    hasD2Key: true,
    hasGuid: true,
    ssoReady: true,
    source: binding,
  },
};
const queries = new Map<string, object>();
function proxy(path = ''): unknown {
  return new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'then') return undefined;
      if (key === 'useQuery')
        return () => {
          if (!queries.has(path))
            queries.set(path, {
              data: data[path],
              isLoading: false,
              isFetching: false,
              refetch: async () => ({ data: data[path] }),
            });
          return queries.get(path);
        };
      if (key === 'useMutation') return () => ({ mutate() {}, isLoading: false });
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      if (key === 'mutate')
        return async (input: { url: string }) => {
          if (path !== 'account.qqActions.favoriteFromMedia') return undefined;
          favoriteRequests.push(input);
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (params.has('fail')) throw new Error('合成取图失败，请稍后重试');
          ids = ['fixture-emoji-id'];
          return { state: 'accepted', emojiId: ids[0] };
        };
      if (key === 'query' || key === 'fetch')
        return async () => (path === 'account.qqActions.favoriteIds' ? ids : data[path]);
      if (key === 'invalidate')
        return async () => {
          favoriteInvalidations.push(path);
        };
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
