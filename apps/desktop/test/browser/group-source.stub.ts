const binding = { expectedAccountUin: '99999', expectedAccountConfigId: 'fixture' };
export const file = {
  fileId: '/fixture-file',
  fileName: '群文件定位测试-长文件名-合成资料.txt',
  fileSize: 1024,
  busId: 102,
  uploadedTime: 1794380000,
  modifiedTime: 0,
  expireTime: 0,
  downloadedTimes: 1,
  uploaderUin: 10001,
  uploaderName: '合成成员',
  parentDirectory: '/',
};
type Qa = { mode: string; reads: number };
const qa = () => (window as unknown as { groupSourceQa: Qa }).groupSourceQa;
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => {
          const name = path.at(-1);
          const data =
            name === 'getAccountConfig'
              ? { uin: '99999', configId: 'fixture' }
              : name === 'getGroupAlbumAccessState'
                ? {
                    qqOnline: true,
                    attachEnabled: true,
                    hasA2: true,
                    hasD2: true,
                    hasD2Key: true,
                    hasGuid: true,
                    ssoReady: true,
                    source: binding,
                  }
                : name === 'listGroupFiles'
                  ? { targetDirectory: '/', files: [file], folders: [] }
                  : name === 'todoLocalList'
                    ? [{ sequence: '9007199254740999', text: '合成群待办正文' }]
                    : name === 'todoList'
                      ? []
                      : undefined;
          return { data, isLoading: false, isFetching: false, refetch: async () => ({ data }) };
        };
      if (key === 'useMutation')
        return () => ({ mutate: () => {}, mutateAsync: async () => {}, isLoading: false });
      if (key === 'query' && path.at(-1) === 'findGroupFileMessages')
        return async () => {
          qa().reads++;
          if (qa().mode === 'error') throw new Error('合成查询失败');
          const rows = ['12', '11'].map((seq) => ({
            msgId: `900${seq}`,
            msgSeq: seq,
            sendTime: '1794380000',
            senderUid: 'u_fixture',
          }));
          return {
            messages: qa().mode === 'empty' ? [] : qa().mode === 'single' ? rows.slice(0, 1) : rows,
            nextBefore: null,
          };
        };
      if (['query', 'mutate', 'invalidate', 'fetch'].includes(String(key)))
        return async () => undefined;
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
