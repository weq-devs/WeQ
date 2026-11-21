export { trpc } from './trpc.stub';

export const client = {
  account: {
    searchQuick: {
      query: async () => ({ contacts: [{ uin: '12345', nick: '小林', remark: '', aliases: [] }] }),
    },
    searchConversationRecords: {
      query: async ({
        keyword,
        recordFilter,
      }: {
        keyword: string;
        recordFilter?: { sender?: string; start?: number; category?: string };
      }) => ({
        ...(recordFilter
          ? {
              limited:
                recordFilter.sender !== '12345' ||
                !recordFilter.start ||
                recordFilter.category !== 'file',
            }
          : {}),
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
      query: async ({
        keyword,
        offset,
        recordFilter,
        sources,
      }: {
        keyword: string;
        offset: number;
        recordFilter?: { sender?: string; start?: number; category?: string };
        sources?: string[];
      }) => {
        if (recordFilter) {
          if (sources?.join(',') !== 'qq') throw new Error('QQ 消息筛选提交了其他来源');
          const matched =
            recordFilter.sender === '12345' &&
            recordFilter.start &&
            recordFilter.category === 'file';
          return {
            category: 'chatRecord',
            items: matched
              ? [
                  {
                    category: 'chatRecord',
                    source: 'group',
                    partition: 'group-filtered',
                    targetUid: 'group-filtered',
                    targetUin: '',
                    name: '命中筛选的项目群',
                    count: 5,
                  },
                ]
              : [],
            total: matched ? 1 : 0,
            limited: true,
            hasMore: false,
          };
        }
        return {
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
        };
      },
    },
  },
};
