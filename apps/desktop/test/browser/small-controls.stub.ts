import { useState } from 'react';
import { trpc as base, client, qa as extras } from './profile-extras.stub';

export { client };
const params = new URLSearchParams(location.search);
const online = !params.has('offline');
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
export const qa = { extras, operations: [] as string[] };
const invalidate = async () => {};
const cache = { invalidate };
const roster = {
  categories: [{ id: 1, name: '朋友', buddyCount: 0, sortOrder: 0 }],
  friends: [],
};
function useMutation(kind: string) {
  return {
    mutateAsync: async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      qa.operations.push(kind);
      return { state: 'confirmed' as const };
    },
  };
}
export function useQQWriteSession() {
  const [busy, setBusy] = useState(false);
  return {
    available: online,
    binding,
    busy,
    run: async (action: (input: typeof binding) => Promise<unknown>) => {
      setBusy(true);
      try {
        await action(binding);
        return true;
      } finally {
        setBusy(false);
      }
    },
  };
}
export const trpc = {
  ...base,
  useUtils: () => ({
    account: {
      getSelfProfile: cache,
      listCategories: cache,
      listBuddies: cache,
      profileExtras: { avatarHistory: cache },
    },
  }),
  account: {
    ...base.account,
    qqWrite: {
      selfAvatar: { useMutation: () => useMutation('avatar') },
      friendCategories: { useMutation: () => useMutation('category') },
      friendRoster: { useQuery: () => ({ data: roster, refetch: invalidate }) },
    },
    profileExtras: {
      ...base.account.profileExtras,
      avatarHistory: {
        useInfiniteQuery: () => ({
          data: {
            pages: [
              {
                items: Array.from({ length: 6 }, (_, index) => ({
                  id: String(index),
                  url: '/resources/qqlevel/penguin.png',
                  thumbnailUrl: '/resources/qqlevel/penguin.png',
                  firstUsedAt: 1700000000 + index * 86400,
                  lastUsedAt: 1700100000 + index * 86400,
                })),
                hasMore: false,
                nextCursor: null,
              },
            ],
          },
          error: params.has('error') ? new Error('合成错误') : null,
          isFetching: params.has('loading'),
          hasNextPage: false,
          refetch: invalidate,
          fetchNextPage: invalidate,
        }),
      },
    },
  },
};
