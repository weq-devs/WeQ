import { useSyncExternalStore } from 'react';
import type { AssistantStep, ConversationTurn } from '@weq/service';

const listeners = new Set<() => void>();
const events = new Set<(event: unknown) => void>();
let revision = 0;
let body = '已整理出第一部分。\n\n';
let running = true;
let resumable = false;
const answer = (status: ConversationTurn['status']): ConversationTurn => ({
  id: 'answer',
  role: 'assistant',
  text: body,
  ts: 2,
  status,
  steps: [],
});
const data: Record<string, unknown> = {
  getSettings: {},
  getSelfProfile: { uin: '10000', nick: '我' },
  getAccountConfig: { uin: '10000', configId: 'fixture' },
  getAssistantConfig: { model: { useDefault: true }, reasoningEffort: 'off' },
  getAgentLabDefaultModel: { ref: { providerId: 'fixture', model: 'fixture' }, available: true },
  listAgentLabProviders: [],
  getAssistantConversation: [
    { id: 'question', role: 'user', text: '整理这份聊天记录。', ts: 1 },
    answer('running'),
  ],
};
function emit(step: AssistantStep) {
  for (const listener of events)
    listener({
      sessionId: 'fixture',
      runId: 'run',
      messageId: 'answer',
      step,
    });
}
function refresh(status: ConversationTurn['status']) {
  data.getAssistantConversation = [
    (data.getAssistantConversation as ConversationTurn[])[0],
    answer(status),
  ];
  revision++;
  for (const listener of listeners) listener();
}
export const assistantFixture = {
  append(text: string) {
    body += text;
    emit({ kind: 'text_delta', text });
  },
  finish() {
    running = false;
    resumable = false;
    emit({ kind: 'final', text: body });
    refresh('complete');
  },
};
function query(name: string) {
  if (name === 'assistantQueue') return { items: [], running, paused: !running };
  if (name === 'getAssistantResumeState') return { resumable };
  return data[name];
}
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      const name = path.at(-1)!;
      if (key === 'useUtils') return () => utils;
      if (key === 'useQuery')
        return () => {
          useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            () => revision,
          );
          return { data: query(name), isSuccess: true, isFetching: false };
        };
      if (key === 'invalidate') return async () => {};
      if (key === 'query') return async () => query(name);
      if (key === 'subscribe')
        return (_input: unknown, handler: { onData: (event: unknown) => void }) => {
          if (name === 'onAssistantEvent') events.add(handler.onData);
          return {
            unsubscribe: () => {
              events.delete(handler.onData);
            },
          };
        };
      if (key === 'mutate')
        return async (input: { action: string }) => {
          if (name === 'controlAssistantQueue') {
            running = input.action !== 'stop';
            resumable = !running;
            emit({ kind: 'turn', turn: answer(running ? 'running' : 'stopped') });
            if (!running) emit({ kind: 'aborted' });
            refresh(running ? 'running' : 'stopped');
          }
          return {};
        };
      if (key === 'useMutation')
        return () => ({ mutate: () => {}, mutateAsync: async () => ({}), isLoading: false });
      return proxy([...path, String(key)]);
    },
  });
const utils = proxy(['utils']);
export const trpc = proxy();
export const client = proxy();
