import { trpc as fallback } from './trpc.stub';

export const trpc = new Proxy(fallback as object, {
  get(target, key, receiver) {
    if (key === 'bootstrap' && new URLSearchParams(location.search).has('number-fonts'))
      return {
        getSettings: {
          useQuery: () => ({ data: { contactCard: { visible: { uid: true } } } }),
        },
      };
    return Reflect.get(target, key, receiver);
  },
});

export const client = {
  account: {
    getCardDisplayNames: {
      query: async () => {
        throw new Error('合成离线名片：保留传入资料');
      },
    },
  },
};
