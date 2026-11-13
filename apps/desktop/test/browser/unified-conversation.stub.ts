import { useSyncExternalStore } from 'react';
import { ASSISTANT_PARAMETER_DEFAULTS } from '@weq/service/assistant-config';
import type { AssistantStep, ConversationTurn } from '@weq/service';

export const requests: Array<{ name: string; input: unknown }> = [];
const updates = new Set<() => void>();
const events = new Set<
  (event: { sessionId: string; runId: string; messageId?: string; step: AssistantStep }) => void
>();
let revision = 0;
let serial = 0;
let preferences: Record<string, unknown> = {};
const notify = () => {
  revision++;
  for (const listener of updates) listener();
};
const time = Date.parse('2026-11-13T08:00:00+08:00');
const turns: ConversationTurn[] = [
  { id: 'user-1', role: 'user', text: '总结合成记录，并保留工具过程。', ts: time },
  {
    id: 'answer-1',
    role: 'assistant',
    text:
      '## 合成记录\n\n已找到三条记录。\n\n| 项目 | 状态 |\n| --- | --- |\n| 资料整理 | 已完成 |\n\n```ts\nconst result = records.filter(record => record.ready);\n```\n\n' +
      '这是一段用于检查换行和消息宽度的合成回答。'.repeat(12),
    ts: time + 1000,
    status: 'complete',
    steps: [
      {
        kind: 'tool_call',
        id: 'tool-1',
        name: 'search_messages',
        args: { keyword: '合成记录', description: '完整参数'.repeat(80) },
      },
      {
        kind: 'tool_result',
        id: 'tool-1',
        name: 'search_messages',
        ok: true,
        preview: JSON.stringify({ count: 3, text: '合成记录' }),
      },
    ],
  },
];
const queue = {
  running: false,
  paused: false,
  items: [] as Array<{ requestId: string; text: string; status: string }>,
};
const data: Record<string, unknown> = {
  getAccountConfig: { uin: '10000', configId: 'synthetic' },
  getSelfProfile: { uin: '10000', uid: 'u_self', nick: '我' },
  getAssistantConfig: {
    ...ASSISTANT_PARAMETER_DEFAULTS,
    model: { useDefault: true },
    reasoningEffort: 'off',
    permissionMode: 'sandbox',
    customPrompt: '',
    mcpServers: '',
  },
  getAgentLabDefaultModel: { ref: { providerId: 'fixture', model: 'fixture' }, available: true },
  listAgentLabProviders: [
    {
      id: 'fixture',
      name: '合成服务商',
      baseUrl: 'https://fixture.invalid',
      models: [
        {
          id: 'fixture',
          label: '合成模型',
          capabilities: ['chat'],
          reasoningEfforts: ['minimal', 'high'],
        },
      ],
    },
  ],
  getAssistantConversation: turns,
  assistantQueue: queue,
  getAssistantResumeState: { resumable: false },
  getSettings: { aiImages: { assistant: 'vision', cloneChat: 'vision' } },
  overview: {
    faces: [
      {
        key: 'face',
        label: '系统表情',
        unicode: false,
        items: [{ id: '14', desc: '微笑', unicode: false, glyph: '' }],
      },
    ],
    recent: [],
    favorites: [],
    tags: [],
  },
};
const wireRows: Array<{ msgId: string; msgSeq: string; sendTime: string; senderUid: string; sendType: string; elements: Array<{ type: string; data: Record<string, unknown> }> }> = [1, 2, 3].map((id) => ({
  msgId: String(id),
  msgSeq: String(id),
  sendTime: String(time / 1000 + id),
  senderUid: 'u_peer',
  sendType: '0',
  elements: [{ type: 'text', data: { textContent: `合成消息 ${id}` } }],
}));
for (const [id, elements] of [
  [4, [{ type: 'ark', data: { arkData: JSON.stringify({ app: 'com.tencent.structmsg', view: 'news', meta: { news: { title: '合成图文消息', desc: '没有 prompt 的卡片也保留', preview: '/_media/fixture-preview', jumpUrl: 'https://fixture.invalid' } } }) } }]],
  [5, [{ type: 'text', data: { textContent: '合成图片消息' } }, { type: 'pic', data: { fileName: 'fixture.png', md5HexStr: 'a'.repeat(32), originalUrl: '/_media/fixture-image', imgWidth: 240, imgHeight: 160, fileSize: 1024 } }]],
  [6, [{ type: 'unknown', data: { rawType: 9999 } }]],
] as Array<[number, Array<{ type: string; data: Record<string, unknown> }>]>) wireRows.push({ msgId: String(id), msgSeq: String(id), sendTime: String(time / 1000 + id), senderUid: 'u_peer', sendType: '0', elements });
export function emitStep(step: AssistantStep) {
  for (const listener of events)
    listener({ sessionId: 'session', runId: 'runtime', messageId: 'running-answer', step });
}
function mutate(name: string, value: unknown) {
  requests.push({ name, input: value });
  const input = value as Record<string, unknown>;
  if (name === 'patch') {
    preferences = { ...preferences, ...input };
    notify();
    return { epoch: 'fixture', revision, values: preferences };
  }
  if (name === 'setAssistantConfig')
    data.getAssistantConfig = { ...(data.getAssistantConfig as object), ...input };
  if (name === 'submitAssistantMessage') {
    const text = String(input.text);
    const mode = input.mode ?? (data.getAssistantConfig as { sendMode: string }).sendMode;
    if (queue.running && mode === 'queue')
      queue.items.push({ requestId: String(input.requestId), text, status: 'pending' });
    else {
      const current = turns.find((turn) => turn.id === 'running-answer');
      if (current) {
        current.status = 'complete';
        current.id = `segment-${serial}`;
      }
      const user: ConversationTurn = {
        id: String(input.requestId),
        role: 'user',
        text,
        ts: Date.now(),
      };
      const answer: ConversationTurn = {
        id: 'running-answer',
        role: 'assistant',
        text: '正在处理合成任务…',
        ts: Date.now() + 1,
        status: 'running',
      };
      turns.push(user, answer);
      queue.running = true;
      const token = ++serial;
      queueMicrotask(() => {
        emitStep({ kind: 'turn', turn: user });
        emitStep({ kind: 'turn', turn: answer });
      });
      setTimeout(() => {
        if (serial === token) emitStep({ kind: 'text_delta', text: '合成流式输出' });
      }, 80);
    }
  }
  if (name === 'controlAssistantQueue') {
    serial++;
    queue.running = false;
    queue.paused = true;
    const current = turns.find((turn) => turn.id === 'running-answer');
    if (current) current.status = 'stopped';
    emitStep({ kind: 'aborted' });
    data.getAssistantResumeState = { resumable: true };
  }
  if (name === 'editAssistantQueue')
    queue.items = queue.items.filter((item) => item.requestId !== input.requestId);
  notify();
  return name === 'setAssistantConfig'
    ? data.getAssistantConfig
    : { messageId: input.requestId, status: 'pending' };
}
function proxy(path: string[] = []): unknown {
  return new Proxy(() => proxy(path), {
    get: (_target, key) => {
      const name = path.at(-1)!;
      if (key === 'useQuery')
        return (_input: unknown, options?: { enabled?: boolean }) => {
          useSyncExternalStore(
            (listener) => {
              updates.add(listener);
              return () => updates.delete(listener);
            },
            () => revision,
          );
          return {
            data: options?.enabled === false ? undefined : data[name],
            isLoading: false,
            isFetching: false,
            isSuccess: true,
            refetch: async () => ({ data: data[name] }),
          };
        };
      if (key === 'useMutation')
        return () => ({
          mutate: (input: unknown) => mutate(name, input),
          mutateAsync: async (input: unknown) => mutate(name, input),
          isLoading: false,
        });
      if (key === 'mutate') return async (input: unknown) => mutate(name, input);
      if (key === 'query')
        return async (input: unknown) => {
          requests.push({ name, input });
          if (name === 'readonlyConversationPage')
            return {
              items: [...wireRows].reverse(),
              hasMore: false,
              nextCursor: null,
              newerCursor: null,
              found: true,
            };
          if (name === 'guildDirectListSessions')
            return [
              {
                nodeId: '77',
                peerTinyId: '88',
                peerNick: '合成频道好友',
                peerAvatarUrl: null,
                guildName: '合成频道',
                lastTime: String(time / 1000),
              },
            ];
          if (name === 'guildDirectLatest') return [...wireRows].reverse();
          if (name === 'guildDirectBefore' || name === 'guildDirectAfter') return [];
          if (name === 'searchReadonlyConversation') return { items: wireRows, hasMore: false };
          return data[name] ?? null;
        };
      if (key === 'subscribe')
        return (_input: unknown, handlers: { onData: Parameters<typeof events.add>[0] }) => {
          if (name === 'onAssistantEvent') events.add(handlers.onData);
          return { unsubscribe: () => events.delete(handlers.onData) };
        };
      if (key === 'invalidate') return async () => notify();
      if (key === 'setData')
        return (_input: unknown, next: unknown) => {
          data[name] = next;
          notify();
        };
      return proxy([...path, String(key)]);
    },
  });
}
export const trpc = proxy();
export const client = proxy();
