export { client } from './settings-defaults.stub';

export const trpc = {
  account: {
    getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'synthetic' } }) },
    clearLocalReadRecords: {
      useMutation: () => ({ mutateAsync: async () => ({ cleared: true }) }),
    },
  },
  useUtils: () => ({ account: { getUnreadInfos: { invalidate: async () => {} } } }),
};
