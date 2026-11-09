export const relationData = {
  selfUin: '10001',
  nodes: [
    {
      uid: 'u_fixture',
      uin: '10002',
      nick: '合成群友',
      card: '',
      groupCount: 2,
      groupCodes: ['20001', '20002'],
      intimacy: 0,
      isFriend: true,
    },
  ],
  groups: [{ code: '20001', name: '合成群聊', memberCount: 12, sharedCount: 1, myLevel: 3 }],
  scannedGroups: 2,
  builtAt: 0,
};
const noop = () => {};
function proxy(path = ''): unknown {
  return new Proxy(noop, {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({
          data: path === 'account.getRelationGraph' ? relationData : undefined,
          isLoading: false,
          isFetching: false,
        });
      if (key === 'useMutation') return () => ({ mutate: noop, mutateAsync: async () => null });
      if (key === 'query') return async () => null;
      if (key === 'then') return undefined;
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
