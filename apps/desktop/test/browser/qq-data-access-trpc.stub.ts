const access = {
  status: 'denied',
  applicationPath: '/Applications/WeQ 测试应用.app',
  launchApplicationPath: '/System/Applications/Utilities/Terminal.app',
  issues: [{ path: `/fixture/QQ/${'long-directory-'.repeat(12)}/nt_db/login.db`, code: 'EPERM' }],
};
const proxy = (path = ''): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      const data = () =>
        path.endsWith('qqDataAccess')
          ? access
          : path.endsWith('probeOnline')
            ? { count: null, runningCount: 1 }
            : path.endsWith('getSettings')
              ? { restrictedModeBannerEnabled: false }
              : path.endsWith('sipEnabled')
                ? false
                : path.endsWith('listAccounts') || path.endsWith('listAccountConfigs')
                  ? path.endsWith('listAccountConfigs')
                    ? [
                        {
                          configId: 'fixture-live',
                          uin: '10001',
                          displayName: '合成账号',
                          dbKey: '0123456789abcdef',
                          dataDir: '/fixture/QQ/nt_qq_fixture',
                          lastLoginAt: 0,
                        },
                      ]
                    : []
                  : null;
      if (key === 'useQuery')
        return () => ({
          data: data(),
          isLoading: false,
          isFetching: false,
          refetch: async () => ({ data: data() }),
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
