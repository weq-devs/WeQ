const mode = new URLSearchParams(location.search).get('mode');
export const trpc = {
  account: {
    getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'fixture' } }) },
    getGroupAlbumAccessState: { useQuery: () => ({ data: undefined }) },
  },
  useUtils: () => ({}),
};
const preview = Array.from({ length: 5 }, (_, index) => ({
  uin: String(10003 + index),
  uid: '',
  nickname: '',
}));
let reads = 0;
export const client = {
  bootstrap: { getSettings: { query: async () => ({}) } },
  account: {
    qzone: {
      cancel: { mutate: async () => {} },
      archiveState: {
        query: async () => {
          if (mode === 'error' && ++reads === 1) throw new Error('暂时无法读取推预览');
          const upvote =
            mode === 'unknown'
              ? null
              : {
                  count: mode === 'empty' ? 0 : 199,
                  upvoted: false,
                  users: mode === 'empty' ? [] : preview,
                };
          return {
            rawStatus: mode === 'manage' ? 0 : 2,
            capabilitiesObserved: true,
            tag:
              mode === 'tag'
                ? {
                    text: '空友爱看',
                    iconUrl: '',
                    targetUrl: 'mqzone://arouse/publicrecommend/feeds?source=4',
                  }
                : null,
            showUpvote: mode !== 'manage',
            canContribute: mode === 'manage',
            canUncontribute: false,
            canUnarchive: false,
            upvote,
          };
        },
      },
      people: {
        query: async () =>
          Object.fromEntries(
            preview.map((user, index) => [
              user.uin,
              index === 1
                ? 'LongSyntheticNicknameWithoutSpaces'.repeat(4)
                : `合成推用户${index + 1}`,
            ]),
          ),
      },
    },
    qzonePublic: {
      cancel: { mutate: async () => {} },
      me: {
        query: async () => ({ uin: '10001', uid: 'self', publicUid: 'self', nick: '合成自己' }),
      },
      capabilities: {
        query: async () => ({
          public_qzone_entrance_switch: true,
          can_upvote: mode !== 'readonly',
        }),
      },
      feeds: {
        query: async () => ({
          feeds: [
            {
              cell_common: { union_id: { uf_key: 'fixture' }, time: '1700000000' },
              cell_user_info: { user: { uin: '10002', uid: 'author', nick: '合成空友作者' } },
              cell_summary: { summary: [{ type: 0, content: '合成空友动态' }] },
              cell_like: { num: 23, liked: false },
              cell_comment: { num: 4 },
              cell_foward_info: { retweet_count: 7 },
              cell_visitor: { view_num: 1280 },
              cell_upvote: {
                num: 199,
                upvoted: false,
                upvote_mans: [
                  { user: { uin: '10003', uid: 'preview-uin', nick: '合成空友推用户' } },
                  { user: { uid: 'preview-uid', nick: '匿名空友预览' } },
                ],
              },
            },
          ],
          has_more: false,
        }),
      },
      upvote: { mutate: async () => ({ upvote: {} }) },
    },
  },
};
