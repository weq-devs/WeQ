export { trpc } from './trpc.stub';

export const client = {
  account: {
    getCardDisplayNames: {
      query: async () => {
        throw new Error('合成离线名片：保留传入资料');
      },
    },
  },
};
