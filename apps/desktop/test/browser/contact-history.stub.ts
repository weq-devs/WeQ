const qa = () => (window as unknown as { contactHistoryQa: { mode: string } }).contactHistoryQa;
const row = {
  id: 2,
  category: 'members',
  source: 'online',
  completeness: 'complete',
  scope: '',
  first_at: 1794380000000,
  last_at: 1794380200000,
};
const previous = [
  { uid: 'u_old', nick: '旧成员', card: '旧名片' },
  { uid: 'u_stay', nick: '成员', card: '旧名片' },
];
const current = [
  { uid: 'u_new', nick: '新成员', card: '超长名片内容'.repeat(30) },
  { uid: 'u_stay', nick: '成员', card: '新名片' },
];
export const trpc = {
  account: {
    getAccountConfig: { useQuery: () => ({ data: { uin: '99999', configId: 'fixture' } }) },
    contactMetrics: {
      history: {
        categories: { useQuery: () => ({ data: ['members', 'getGroupDetail'] }) },
        status: {
          useQuery: () => ({
            data: {
              versions: 10,
              contents: 8,
              bytes: 10000,
              lastError: null,
              migrationErrors: qa().mode === 'migration' ? ['旧缓存格式错误'] : [],
            },
            refetch: async () => {},
          }),
        },
        list: {
          useQuery: (input: { before?: number; category?: string }) => ({
            data:
              qa().mode === 'empty'
                ? { rows: [], nextBefore: null }
                : {
                    rows: [
                      { ...row, id: input.before ? 1 : 2, category: input.category || 'members' },
                    ],
                    nextBefore: input.before ? null : 2,
                  },
            isLoading: qa().mode === 'loading',
            isFetching: false,
            error: qa().mode === 'error' ? { message: '合成读取失败' } : null,
            refetch: async () => {},
          }),
        },
        diff: {
          useQuery: () => ({
            data: {
              current: {
                ...row,
                completeness: qa().mode === 'partial' ? 'page' : 'complete',
                value: current,
              },
              previous: { ...row, id: 1, value: previous },
            },
            isFetching: false,
            error: null,
          }),
        },
      },
    },
  },
};
