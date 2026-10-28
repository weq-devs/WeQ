const album = {
  id: 'album-a',
  name: '合成旅行相册',
  mediaCount: 12,
  coverUrl: '',
  desc: '',
  createTime: 0,
  priv: 0,
};
const values: Record<string, unknown> = {
  'bootstrap.getSettings': { exportSaveMode: 'before' },
  'bootstrap.listAgentLabProviders': [],
  'account.getAccountConfig': { uin: '10001', configId: 'synthetic' },
  'account.listAgentLabPersonas': [{ id: 'synthetic', name: '合成克隆' }],
  'account.getAgentLabExportInfo': null,
  'account.analysisGroupDirectory': [{ groupCode: '777', groupName: '合成群聊', memberCount: 12 }],
  'account.analysisPeerDirectory': [{ uid: 'u_peer', uin: '20002', name: '合成好友' }],
  'account.getGroupAlbumAccessState': { qqOnline: true, attachEnabled: true },
  'account.qzone.albumPage': { albums: [album], nextOffset: null, total: 1, warning: null },
};
function proxy(path = ''): unknown {
  return new Proxy(() => undefined, {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({
          data: values[path],
          isLoading: false,
          isFetching: false,
          isError: false,
          refetch: async () => ({ data: values[path] }),
        });
      if (key === 'query') return async () => values[path];
      if (key === 'useUtils') return () => proxy();
      if (key === 'invalidate') return async () => undefined;
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          mutateAsync: async () => ({ canceled: false, taskId: 'synthetic-task' }),
        });
      if (key === 'mutate') return async () => null;
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
