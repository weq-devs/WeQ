import { useSyncExternalStore } from 'react';

let revision = 0;
const watchers = new Set<() => void>();
const channels = new Map<string, Set<(value: unknown) => void>>();
const subscribe = (listener: () => void) => {
  watchers.add(listener);
  return () => {
    watchers.delete(listener);
  };
};
function refresh() {
  revision++;
  for (const listener of watchers) listener();
}
function emit(name: string, value: unknown) {
  for (const listener of channels.get(name) ?? []) listener(value);
}
let serial = 1;
const assistant: unknown[] = [];
const clone: unknown[] = [];
const group: unknown[] = [];
const model = { providerId: 'fixture', model: 'visual-fixture' };
const settings = {
  aiImages: {
    assistant: 'vision',
    cloneChat: 'vision',
    cloneTraining: 'placeholder',
    intent: 'placeholder',
    suggestions: 'placeholder',
    profile: 'placeholder',
  } as Record<string, string>,
  agentLab: { defaultModel: model, defaultVisionModel: null as typeof model | null },
  ocr: { prefilterEnabled: true },
};
export const imageRequests: Array<{ name: string; input: unknown }> = [];
const data: Record<string, unknown> = {
  getSettings: settings,
  getAccountConfig: { uin: '10000', configId: 'fixture' },
  getAgentLabDefaultModel: { ref: model, available: true, error: null },
  getDefaultVisionModel: { ref: null, available: false, error: null },
  listAgentLabProviders: [
    {
      id: 'fixture',
      name: '合成服务商',
      baseUrl: 'https://fixture.invalid',
      models: [{ id: 'visual-fixture', capabilities: ['chat', 'vision'] }],
    },
  ],
  getAssistantConfig: {
    model: { useDefault: true },
    permissionMode: 'sandbox',
    reasoningEffort: 'off',
  },
  getAssistantConversation: assistant,
  getAssistantResumeState: null,
  assistantQueue: { items: [], running: null },
  getAgentLabConversation: clone,
  getAgentLabGroupConversation: group,
  getAgentLabGroupDetail: {
    group: { id: 'g', name: '合成图片群聊' },
    members: [
      { memberId: 'p', kind: 'persona', displayName: '合成克隆' },
      { memberId: 'self', kind: 'user', displayName: '我' },
    ],
  },
  getSelfProfile: { uin: '10000', nick: '我' },
};
function turn(role: string, text: string, images?: unknown[]) {
  return { id: `m${serial++}`, role, text, images, ts: Date.now() };
}
async function mutate(name: string, input: Record<string, unknown>) {
  imageRequests.push({ name, input });
  if (name === 'setAiImagePreference') {
    settings.aiImages[String(input.feature)] = String(input.mode);
    refresh();
    return settings;
  }
  if (name === 'setDefaultVisionModel') {
    settings.agentLab.defaultVisionModel = input.ref as typeof model | null;
    data.getDefaultVisionModel = { ref: input.ref, available: !!input.ref, error: null };
    refresh();
    return data.getDefaultVisionModel;
  }
  if (name === 'pickedFileStart') return { id: '00000000-0000-4000-8000-000000000001' };
  if (name === 'pickedFileChunk')
    return { offset: Number(input.offset) + atob(String(input.base64)).length };
  if (name === 'pickedFileFinish')
    return { path: '/synthetic/upload.png', fileName: '合成截图.png', size: 68 };
  if (name === 'retainAiImage') {
    const id = (serial++).toString(16).padStart(64, '0') + '.png';
    return { id, path: `/synthetic/${id}`, name: '合成截图.png' };
  }
  if (name === 'chatWithAgentLabPersona') {
    clone.push(
      turn('user', String(input.text), input.images as unknown[]),
      turn('assistant', '合成克隆看图回复'),
    );
    refresh();
    return {
      text: '合成克隆看图回复',
      segments: ['合成克隆看图回复'],
      renderedTurns: ['合成克隆看图回复'],
      silent: false,
      replyDelayMs: 0,
    };
  }
  if (name === 'chatWithAssistant' || name === 'submitAssistantMessage') {
    const runId = `run${serial++}`;
    setTimeout(() => {
      const mine = turn('user', String(input.text), input.images as unknown[]);
      const reply = turn('assistant', '合成助手看图回复');
      assistant.push(mine, reply);
      for (const value of [mine, reply])
        emit('onAssistantEvent', {
          runId,
          sessionId: String(input.sessionId),
          messageId: value.id,
          step: { kind: 'turn', turn: value },
        });
      emit('onAssistantEvent', {
        runId,
        sessionId: String(input.sessionId),
        messageId: reply.id,
        step: { kind: 'final', text: '合成助手看图回复' },
      });
      refresh();
    }, 20);
    return { runId };
  }
  if (name === 'sendAgentLabGroupMessage') {
    setTimeout(() => {
      const mine = {
        id: `g${serial++}`,
        groupId: 'g',
        senderId: 'self',
        senderKind: 'user',
        text: String(input.text),
        images: input.images,
        ts: Date.now(),
      };
      const reply = {
        id: `g${serial++}`,
        groupId: 'g',
        senderId: 'p',
        senderKind: 'persona',
        text: '合成群聊看图回复',
        ts: Date.now() + 1,
      };
      group.push(mine, reply);
      for (const message of [mine, reply])
        emit('onGroupChatEvent', {
          groupId: 'g',
          groupRunId: 'group-run',
          kind: 'message',
          message,
        });
      emit('onGroupChatEvent', { groupId: 'g', groupRunId: 'group-run', kind: 'done' });
      refresh();
    }, 20);
    return { groupRunId: 'group-run' };
  }
  return {};
}
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      const name = path.at(-1)!;
      if (key === 'useUtils') return () => utils;
      if (key === 'useQuery')
        return (_input: unknown, options?: { enabled?: boolean }) => {
          useSyncExternalStore(subscribe, () => revision);
          return {
            data: options?.enabled === false ? undefined : data[name],
            isLoading: false,
            isFetching: false,
            isSuccess: true,
            refetch: async () => ({ data: data[name] }),
          };
        };
      if (key === 'query') return async () => data[name] ?? null;
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          mutateAsync: (input: Record<string, unknown>) => mutate(name, input),
          mutate: (input: Record<string, unknown>) => {
            void mutate(name, input);
          },
        });
      if (key === 'mutate') return (input: Record<string, unknown>) => mutate(name, input);
      if (key === 'invalidate')
        return async () => {
          refresh();
        };
      if (key === 'setData')
        return () => {
          refresh();
        };
      if (key === 'subscribe')
        return (_input: unknown, handler: { onData?: (value: unknown) => void }) => {
          const set = channels.get(name) ?? new Set();
          channels.set(name, set);
          const listener = handler.onData ?? (() => {});
          set.add(listener);
          return {
            unsubscribe: () => {
              set.delete(listener);
            },
          };
        };
      return proxy([...path, String(key)]);
    },
  });
const utils = proxy(['utils']);
export const trpc = proxy();
export const client = proxy();
