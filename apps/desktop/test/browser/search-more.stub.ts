export { trpc } from './trpc.stub';

export const client = {
  account: {
    searchConversationRecords: {
      query: async ({ keyword }: { keyword: string }) => ({
        items: Array.from({ length: 5 }, (_, index) => ({
          msgId: `message-${index}`,
          msgSeq: String(index + 1),
          senderUid: 'sender',
          senderUin: '',
          senderName: '合成成员',
          sendTime: '1',
          content: `${keyword}：会话命中的消息正文，保留原消息定位。`,
        })),
        total: 5,
      }),
    },
    searchMore: {
      query: async ({ keyword, offset }: { keyword: string; offset: number }) => ({
        category: 'contact',
        items: Array.from({ length: 30 }, (_, index) => ({
          category: 'contact',
          uid: `person-${offset + index}`,
          uin: '',
          nick: `${keyword} · 项目资料与讨论记录 ${offset + index + 1}`,
          remark: '',
          avatarUrl: null,
          isFriend: true,
          hasConversation: true,
          temporary: false,
          aliases: [],
          groups: [],
        })),
        total: 60,
        coverage: { scope: 'observed-cache', records: 375, limited: false, updatedAt: 1 },
        hasMore: offset === 0,
      }),
    },
  },
};
