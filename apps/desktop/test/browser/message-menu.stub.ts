import { client as favoriteClient } from './favorite-emoji.stub';

export const client = {
  ...favoriteClient,
  account: {
    ...favoriteClient.account,
    mediaResource: {
      revealMessageMedia: {
        mutate: async ({ location }: { location: { kind: string; key: string } }) => {
          window.menuActions.push(`reveal:${location.kind}:${location.key}`);
          if (location.kind === 'saved')
            throw new Error('另存的文件已被移动或删除，请使用“另存为”重新保存');
          return true;
        },
      },
    },
  },
};

export const useVoiceTranscription = () => ({
  available: true,
  busy: false,
  result: undefined,
  run: () => window.menuActions.push('转文字'),
});

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
    mediaResource: {
      messageLocations: {
        useQuery: () => ({
          data: [
            { kind: 'saved' as const, key: 'saved-file', available: false },
            { kind: 'cache' as const, key: 'cache-file', available: true },
            { kind: 'thumbnail' as const, key: 'thumb-file', available: true },
            { kind: 'cover' as const, key: 'cover-file', available: true },
            { kind: 'transcoded' as const, key: 'wav-file', available: true },
          ],
        }),
      },
    },
    emojiPanel: { overview: { useQuery: () => ({ data: { faces }, isLoading: false }) } },
  },
};
