const access = {
  status: 'denied',
  applicationPath: '/Applications/WeQ 测试应用.app',
  issues: [{ path: `/fixture/QQ/${'long-directory-'.repeat(12)}/nt_db/login.db`, code: 'EPERM' }],
};
const proxy = (path = ''): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({
          data: path.endsWith('qqDataAccess')
            ? access
            : path.endsWith('listAccounts') || path.endsWith('listAccountConfigs')
              ? []
              : null,
          isLoading: false,
          isFetching: false,
          refetch: async () => ({ data: path.endsWith('qqDataAccess') ? access : [] }),
        });
      if (key === 'mutate' && path.endsWith('openQqDataAccessSettings'))
        return async () => {
          throw new Error('合成的系统设置打开失败，请手动打开「隐私与安全性」。');
        };
      if (key === 'useMutation')
        return () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false });
      if (key === 'query' || key === 'fetch' || key === 'invalidate') return async () => undefined;
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy(`${path}.${String(key)}`);
    },
  });
export const trpc = proxy();
export const client = proxy();
