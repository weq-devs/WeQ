export { client } from './favorite-emoji.stub';

const faces = [
  {
    items: [
      { id: '76', desc: '赞' },
      { id: '66', desc: '爱心' },
      { id: '14', desc: '微笑' },
    ],
  },
];
export const trpc = {
  account: {
    emojiPanel: { overview: { useQuery: () => ({ data: { faces }, isLoading: false }) } },
  },
};
