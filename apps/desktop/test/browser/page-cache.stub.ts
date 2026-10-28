import { client as inheritedClient } from './conversation-entry.stub';

export const fixture = { holdHead: false, finish: () => {} };
const collectionClient = {
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
const base = inheritedClient as { account: object };
const account = new Proxy(base.account, {
  get(target, key) {
    return key === 'listCollections'
      ? collectionClient.account.listCollections
      : Reflect.get(target, key);
  },
});
export const client = new Proxy(base, {
  get(target, key) {
    return key === 'account' ? account : Reflect.get(target, key);
  },
});
export { trpc } from './conversation-entry.stub';
export const QqAvatar = () => null;
export const ProfileAvatar = () => null;
export const qqAvatarUrl = () =>
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=';
