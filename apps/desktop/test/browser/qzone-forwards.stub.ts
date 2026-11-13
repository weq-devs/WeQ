let attempts = 0;
export const client = {
  account: {
    qzone: {
      cancel: { mutate: async () => {} },
      forwards: {
        query: async (input: { cursor: unknown }) => {
          attempts++;
          const mode = new URLSearchParams(location.search).get('mode');
          if (mode === 'error' && attempts === 1) throw new Error('暂时无法读取转发名单');
          await new Promise((resolve) => setTimeout(resolve, 50));
          const forwards =
            mode === 'empty' || input.cursor
              ? []
              : [
                  {
                    key: 'a',
                    uin: '10003',
                    nickname: '合成转发者',
                    content: '这一条合成转发语用于检查名单中的正文。',
                    isFriend: true,
                  },
                  {
                    key: 'b',
                    uin: '10004',
                    nickname: '很长的合成昵称和EnglishName',
                    content:
                      '长转发语会自动换行。LongSyntheticTextWithoutSpacesForCheckingWrappingAndKeepingThePopoverWithinTheViewport',
                    isFriend: false,
                  },
                  {
                    key: 'c',
                    uin: '10005',
                    nickname: '另一位合成用户',
                    content: '第二条转发语\n保留换行。',
                    isFriend: false,
                  },
                ];
          return {
            forwards,
            reportedTotal: mode === 'empty' ? 0 : 1288,
            rawCount: forwards.length,
            hasMore: mode !== 'empty',
            nextCursor:
              mode === 'empty' || input.cursor
                ? null
                : { attachInfo: 'next', previousPageKey: 'a'.repeat(64) },
            stopReason: mode === 'empty' ? 'complete' : input.cursor ? 'repeated-page' : null,
          };
        },
      },
    },
  },
};
