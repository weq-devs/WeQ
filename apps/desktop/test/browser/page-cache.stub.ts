export const fixture = { holdHead: false, finish: () => {} };
export const client = {
  account: {
    listCollections: {
      async query({ source, offset }: { source: string; offset: number }) {
        if (source === 'network') return null;
        if (fixture.holdHead) return new Promise(() => {});
        if (offset > 0)
          return new Promise((resolve) => {
            fixture.finish = () => resolve({ items: [], hasMore: false });
          });
        return {
          items: [
            {
              cid: 'first',
              kind: 'text',
              type: 1,
              createTime: 1,
              collectTime: 1,
              text: '首批收藏正文',
              authorName: '',
              authorUin: '',
              groupName: '',
              fullContent: '',
              fullContentFormat: null,
              link: null,
              gallery: null,
              audio: null,
              video: null,
              file: null,
              location: null,
              richMedia: null,
            },
          ],
          hasMore: true,
        };
      },
    },
  },
};
export const trpc = {};
export const QqAvatar = () => null;
export const ProfileAvatar = () => null;
