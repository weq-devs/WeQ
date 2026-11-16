export { client } from './media-preview.stub';
import { trpc as base } from './media-preview.stub';

const marketEmoji = {
  getPackDetail: {
    useQuery: () => ({
      data: {
        name: '合成表情包：用于验证很长的名称不会遮住关闭按钮',
        feeType: 'free',
        count: 24,
        items: Array.from({ length: 24 }, (_, index) => ({
          hash: (index + 1).toString(16).padStart(32, '0'),
          name: `合成表情 ${index + 1}`,
        })),
      },
      isLoading: false,
    }),
  },
  getPackKey: { useQuery: () => ({ data: null, isLoading: false }) },
};
const account = new Proxy(Object(Reflect.get(Object(base), 'account')), {
  get: (target, key) => (key === 'marketEmoji' ? marketEmoji : Reflect.get(target, key)),
});
export const trpc = new Proxy(Object(base), {
  get: (target, key) => (key === 'account' ? account : Reflect.get(target, key)),
});
