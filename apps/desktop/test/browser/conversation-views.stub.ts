import { DEFAULT_OPTIONS } from '../../src/renderer/src/views/export/types';

const query = (data: unknown) => ({
  data,
  isLoading: false,
  isFetching: false,
  isSuccess: true,
  isError: false,
  refetch: async () => ({ data }),
});
const access = {
  qqOnline: false,
  attachEnabled: false,
  hasA2: false,
  hasD2: false,
  hasD2Key: false,
  hasGuid: false,
};
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      const name = path.join('.');
      if (key === 'useQuery')
        return () =>
          query(
            name === 'account.listAssistantSessions'
              ? [
                  {
                    id: 'assistant-one',
                    title: '合成会议整理 · 待办与文档检索',
                    createdAt: 1900000000000,
                    updatedAt: 1900000000000,
                    running: false,
                  },
                ]
              : name === 'account.getAccountConfig'
                ? { uin: '10001', configId: 'synthetic-source' }
                : name === 'bootstrap.getExportPresets'
                  ? { full: { options: DEFAULT_OPTIONS, formats: ['json'] } }
                  : name === 'bootstrap.getSettings'
                    ? { exportSaveMode: 'before' }
                    : undefined,
          );
      if (key === 'useMutation')
        return () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false });
      if (key === 'query' || key === 'fetch' || key === 'invalidate')
        return async () =>
          name === 'account.getGroupAlbumAccessState'
            ? access
            : name === 'wonderfulTools.captureSupport'
              ? { available: false, elevated: false }
              : name === 'account.onlineTranscribeStatus'
                ? { armed: false }
                : undefined;
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
