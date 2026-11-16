import { useQuery } from '@tanstack/react-query';

const params = new URLSearchParams(location.search);
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
const invalidate = async () => {};
export const qa = { reads: [] as string[] };
export function useQQWriteSession() {
  return { available: !params.has('offline'), binding, busy: false, result: null };
}
export const client = {};
export const trpc = {
  useUtils: () => ({
    account: {
      listCategories: { invalidate },
      listBuddies: { invalidate },
    },
  }),
  account: {
    getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'fixture' } }) },
    qqActions: {
      albumPermissions: {
        useQuery: () => ({ data: { create: true, modify: true }, error: null }),
      },
    },
    qqWrite: {
      friendCategories: { useMutation: () => ({ mutateAsync: invalidate }) },
      friendRoster: {
        useQuery: () => ({
          data: {
            categories: [
              { id: 1, name: '朋友', buddyCount: 1, sortOrder: 0 },
              { id: 2, name: '同学', buddyCount: 0, sortOrder: 1 },
            ],
            friends: [{ uid: 'u_fixture', categoryId: 1 }],
          },
          refetch: invalidate,
        }),
      },
      exactProfile: {
        useQuery: (input: { kind: string; target: string }, options: { enabled: boolean }) =>
          useQuery({
            queryKey: ['exactProfile', input],
            queryFn: async () => {
              qa.reads.push(input.target);
              if (params.get('mode') === 'loading') await new Promise(() => {});
              if (params.get('mode') === 'error')
                throw new Error('合成读取失败，请重试。'.repeat(12));
              return {
                kind: input.kind,
                id: input.target,
                name: params.get('mode') === 'long' ? '很长的合成资料名称'.repeat(32) : '合成资料',
                level: input.kind === 'user' ? 42 : null,
                category: input.kind === 'group' ? '兴趣交流' : null,
              };
            },
            ...options,
            retry: false,
          }),
      },
    },
  },
};
