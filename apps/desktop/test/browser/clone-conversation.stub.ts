const ts = new Date('2026-10-27T12:00:00+08:00').getTime();
const turns = [
  { id: 'm1', role: 'assistant', text: '合成消息：今天的计划完成了吗？', ts },
  { id: 'm2', role: 'user', text: '已经完成了，晚点一起讨论。', ts: ts + 1000 },
];
const data: Record<string, unknown> = {
  overview: {
    faces: [
      {
        key: 'face',
        label: '小黄脸表情',
        unicode: false,
        items: [{ id: '14', desc: '微笑', unicode: false, glyph: '' }],
      },
    ],
    recent: [],
    favorites: [],
    tags: [],
  },
  getAgentLabPersonaSessionConversation: turns,
  getAgentLabGroupConversation: turns.map((turn) => ({
    ...turn,
    groupId: 'g',
    senderId: turn.role === 'user' ? 'self' : 'p',
    senderKind: turn.role === 'user' ? 'user' : 'persona',
  })),
  listAgentLabPersonaSessions: [{ id: 's', title: '合成历史会话', createdAt: ts, updatedAt: ts }],
  listAgentLabGroupSessions: [{ id: 's', title: '合成群会话', createdAt: ts, updatedAt: ts }],
  getAgentLabGroupDetail: {
    group: { id: 'g', name: '合成克隆群' },
    members: [
      { memberId: 'p', kind: 'persona', displayName: '合成好友' },
      { memberId: 'self', kind: 'user', displayName: '我' },
    ],
  },
};
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useQuery')
        return (_input: unknown, options?: { enabled?: boolean }) => ({
          data: options?.enabled === false ? undefined : data[path.at(-1)!],
          isLoading: false,
          isFetching: false,
          isSuccess: true,
        });
      if (key === 'useMutation')
        return () => ({
          mutateAsync: async () => ({ sessionId: 's', text: '合成回复', replyDelayMs: 0 }),
          isLoading: false,
        });
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      if (key === 'invalidate') return async () => undefined;
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
