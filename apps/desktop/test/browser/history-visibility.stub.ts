import { withFallback } from './self-profile.stub';
export const reads = { fields: 0, versions: 0, signatures: 0, avatars: 0 };
const emptyPage = { items: [], nextCursor: null, hasMore: false, paginationError: null };
const result = (data: unknown) => ({
  data,
  isFetching: false,
  isLoading: false,
  error: null,
  hasNextPage: false,
  refetch: async () => ({ data }),
  fetchNextPage: async () => {},
});
export const trpc = withFallback({
  bootstrap: { getSettings: { useQuery: () => result({ exportSaveMode: 'before' }) } },
  account: {
    getAccountConfig: { useQuery: () => result({ uin: '10001', configId: 'fixture' }) },
    profileExtras: {
      energy: { useQuery: () => result(undefined) },
      signatureHistory: {
        useInfiniteQuery: () => {
          reads.signatures++;
          return result({ pages: [{ ...emptyPage, targetUin: '10002' }] });
        },
      },
      avatarHistory: {
        useInfiniteQuery: () => {
          reads.avatars++;
          return result({
            pages: [
              {
                ...emptyPage,
                items: [
                  {
                    id: 'a',
                    firstUsedAt: 1700000000,
                    lastUsedAt: 1700100000,
                    url: 'https://q1.qlogo.cn/synthetic/a',
                    thumbnailUrl: 'https://q1.qlogo.cn/synthetic/a',
                  },
                ],
              },
            ],
          });
        },
      },
    },
  },
});
export const client = withFallback({
  account: {
    contactMetrics: {
      history: {
        fieldSummary: {
          query: async () => {
            reads.fields++;
            return { fields: ['nick', 'avatar', 'signature', 'likes'], pending: false };
          },
        },
        fieldVersions: {
          query: async () => {
            reads.versions++;
            return { rows: [], nextBefore: null };
          },
        },
      },
    },
  },
});
export const useQQWriteSession = () => ({
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' },
  available: true,
  busy: false,
});
