export const relationData = {
  selfUin: '10001',
  nodes: [
    {
      uid: 'u_fixture',
      uin: '10002',
      nick: '合成群友',
      remark: '备注示例',
      card: '',
      groupCount: 2,
      groupCodes: ['20001', '20002'],
      intimacy: 1800,
      isFriend: true,
    },
  ],
  groups: [{ code: '20001', name: '合成群聊', memberCount: 12, sharedCount: 1, myLevel: 3 }],
  scannedGroups: 2,
  builtAt: 0,
};
const noop = () => {};
const statusMode = new URLSearchParams(location.search).get('status');
const onlineStatus =
  statusMode === 'online' || statusMode === 'custom'
    ? {
        uid: 'u_self',
        type: 10,
        typeName: '在线',
        subType: statusMode === 'custom' ? 2000 : 0,
        displayStatus: statusMode === 'custom' ? '很长的自定义状态用于验证窄屏省略' : '在线',
        customStatus: { text: '很长的自定义状态用于验证窄屏省略', faceType: 0 },
      }
    : undefined;
function proxy(path = ''): unknown {
  return new Proxy(noop, {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({
          data:
            path === 'account.getRelationGraph'
              ? relationData
              : path === 'account.getOnlineStatus'
                ? onlineStatus
                : undefined,
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
