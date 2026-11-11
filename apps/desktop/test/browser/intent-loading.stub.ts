import { useSyncExternalStore } from 'react';
import type {
  IntentAnalyzedEvent,
  IntentAnalysisProgress,
  IntentProfile,
  IntentSenseResult,
  ReplySuggestionHistoryEntry,
} from '@weq/service';

type Mode = 'loading' | 'ready' | 'error' | 'empty';
let mode: Mode = 'loading';
const listeners = new Set<() => void>();
const progressListeners = new Set<(event: IntentAnalysisProgress) => void>();
const resultListeners = new Set<(event: IntentAnalyzedEvent) => void>();
const readySuggestions = [{ text: '有空一起聊聊', tone: '自然' }];
let finishCache: ((results: IntentSenseResult[]) => void) | undefined;
export function releaseCache() {
  finishCache?.([]);
}
let finish:
  | ((stats: { analyzed: number; failed: number; latestMsgId: string }) => void)
  | undefined;
export const result: IntentSenseResult = {
  msgId: 'message',
  mine: false,
  sendTime: 1000,
  intent: 'chat',
  emotion: 'neutral',
  intensity: 30,
  sentiment: 10,
  confidence: 0.7,
  engine: 'api',
  analyzedAt: 1000,
};
export function publishResult(msgId = 'message') {
  for (const listener of resultListeners)
    listener({ kind: 'c2c', conv: 'fixture', results: [{ ...result, msgId }] });
}
export function publishProgress(
  progress: Pick<IntentAnalysisProgress, 'total' | 'completed' | 'failed' | 'pendingIds'>,
) {
  for (const listener of progressListeners)
    listener({ kind: 'c2c', conv: 'fixture', revision: 0, ...progress });
}
export const portrait: IntentProfile = {
  affinity: 70,
  tier: 3,
  trend: [
    { date: '11-09', score: 60 },
    { date: '11-10', score: 70 },
  ],
  mbti: { letters: 'ENFP', heuristic: true, dims: [{ key: 'EI', leftPct: 60 }] },
  radar: ['主动性', '响应速度', '情绪外露', '话题广度', '正式度'].map((axis) => ({
    axis,
    value: 60,
  })),
  topics: [{ topic: '日常', count: 3 }],
  sampled: 60,
  analyzedSamples: 20,
  engine: 'heuristic',
  computedAt: 1000,
};
let history: ReplySuggestionHistoryEntry[] = [
  {
    id: 'round-2',
    createdAt: 1794283200000,
    target: { msgId: 'previous-message', msgSeq: '77', senderUin: '10000', sendTime: 1794283200 },
    suggestions: readySuggestions,
    summary: '双方正在聊日常，最新消息适合轻松接话。',
    generation: {
      source: 'api',
      model: 'fixture-chat-model',
      providerName: '测试供应商',
      startedAt: 1794283198000,
      durationMs: 2000,
      requestDurationMs: 1800,
      inputMessages: 20,
      usage: { promptTokens: 200, completionTokens: 60, totalTokens: 260 },
    },
  },
  {
    id: 'round-1',
    createdAt: 1794283100000,
    target: { msgId: 'earlier', msgSeq: '66', senderUin: '10000', sendTime: 1794283100 },
    suggestions: [{ text: '上一轮推荐回复', tone: '自然' }, { text: '另一条历史候选' }],
  },
];
const readyRound = { ...history[0]!, target: { ...history[0]!.target, msgId: 'message' } };
export function setHistory(entries: ReplySuggestionHistoryEntry[]) {
  history = entries;
  for (const listener of listeners) listener();
}
function useMode() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => mode,
  );
}
export function setMode(next: Mode) {
  mode = next;
  if (next === 'ready' && history[0]?.id === 'round-2')
    history = history.map((entry, index) =>
      index === 0 ? { ...entry, target: { ...entry.target, msgId: 'message' } } : entry,
    );
  for (const listener of listeners) listener();
  for (const listener of progressListeners)
    listener({
      kind: 'c2c',
      conv: 'fixture',
      revision: 0,
      total: 2,
      completed: next === 'loading' ? 1 : 2,
      failed: next === 'error' ? 1 : 0,
      pendingIds: next === 'loading' ? ['message'] : [],
    });
  if (next !== 'loading')
    finish?.({
      analyzed: next === 'ready' ? 2 : 0,
      failed: next === 'error' ? 1 : 0,
      latestMsgId: 'message',
    });
}
const invalidate = async () => {};
const utils = {
  account: {
    intentSense: { getProfile: { invalidate, setData: () => {} }, getStatus: { invalidate } },
  },
};
export const trpc = {
  useUtils: () => utils,
  account: {
    intentSense: {
      getStatus: {
        useQuery: () => ({
          data: {
            enabled: true,
            analysisMode: new URLSearchParams(location.search).has('manual') ? 'manual' : 'auto',
            profileMode: new URLSearchParams(location.search).has('manual') ? 'manual' : 'auto',
            suggestionMode: new URLSearchParams(location.search).has('manual') ? 'manual' : 'auto',
            engine: 'local',
            localReady: true,
            profileEnabled: true,
            suggestionsEnabled: true,
            persistentDisplay: true,
            loadingAnimation: !new URLSearchParams(location.search).has('animation-off'),
            analysisRevision: 0,
          },
        }),
      },
      getSuggestionRound: {
        useQuery: () => {
          const current = useMode();
          return {
            data: current === 'ready' ? readyRound : null,
            isFetching: current === 'loading',
            error: current === 'error' ? new Error('合成网络错误') : null,
          };
        },
      },
      getSuggestionDetails: {
        useQuery: ({ id }: { id: string }) => ({
          data: {
            entry: id === readyRound.id ? readyRound : history.find((entry) => entry.id === id)!,
            trace:
              id === readyRound.id
                ? {
                    prompt: {
                      system: '根据完整对话，先概括再生成候选。',
                      user: JSON.stringify(
                        {
                          messages: Array.from({ length: 20 }, (_, i) => ({
                            id: i,
                            text: `合成聊天消息 ${i}`,
                          })),
                        },
                        null,
                        2,
                      ),
                    },
                    response:
                      '{"summary":"双方正在聊日常，最新消息适合轻松接话。","replies":[{"text":"有空一起聊聊"}]}',
                  }
                : null,
          },
          isLoading: false,
          isFetching: false,
          error: null,
          refetch: invalidate,
        }),
      },
      getSuggestionHistory: {
        useQuery: () => {
          const data = useSyncExternalStore(
            (listener) => {
              listeners.add(listener);
              return () => {
                listeners.delete(listener);
              };
            },
            () => history,
          );
          return {
            data,
            isFetching: false,
            isLoading: false,
            refetch: invalidate,
          };
        },
      },
      getProfile: {
        useQuery: ({ peerUid }: { peerUid: string }) => {
          const current = useMode();
          const tier = peerUid.startsWith('tier-') ? Number(peerUid.slice(5)) : 3;
          return {
            data:
              current === 'empty'
                ? null
                : current === 'loading'
                  ? undefined
                  : { ...portrait, tier },
            isLoading: current === 'loading',
            isFetching: current === 'loading',
            error: current === 'error' ? new Error('合成刷新失败') : null,
            refetch: invalidate,
          };
        },
      },
    },
  },
};
export const client = {
  account: {
    intentSense: {
      listMessageAnalyses: {
        query: async () =>
          mode === 'ready' || mode === 'error'
            ? [result]
            : new URLSearchParams(location.search).has('first-frame')
              ? new Promise<IntentSenseResult[]>((resolve) => {
                  finishCache = resolve;
                })
              : [],
      },
      ensureAnalysis: {
        mutate: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
      analyzeMessage: { mutate: async () => result },
      onAnalyzed: {
        subscribe: (_: unknown, observer: { onData: (event: IntentAnalyzedEvent) => void }) => {
          resultListeners.add(observer.onData);
          return {
            unsubscribe() {
              resultListeners.delete(observer.onData);
            },
          };
        },
      },
      onAnalysisProgress: {
        subscribe: (_: unknown, observer: { onData: (event: IntentAnalysisProgress) => void }) => {
          progressListeners.add(observer.onData);
          return {
            unsubscribe() {
              progressListeners.delete(observer.onData);
            },
          };
        },
      },
      getSuggestionRound: {
        query: async () => ({
          ...readyRound,
          id: 'manual-round',
          suggestions: [{ text: '重新生成的候选' }],
        }),
      },
      stopSuggestions: {
        mutate: async () => {
          setMode('empty');
          return true;
        },
      },
    },
  },
};
