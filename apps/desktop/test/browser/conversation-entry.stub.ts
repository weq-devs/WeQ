import { useEffect, useState } from 'react';

const params = new URLSearchParams(location.search);
const latestId = `row-${1000 + Number(params.get('count') ?? 3000)}`;
const result = {
  msgId: latestId,
  mine: false,
  sendTime: 1792544400,
  intent: 'question',
  emotion: 'joy',
  intensity: 0.6,
  sentiment: 0.8,
  confidence: 0.9,
  engine: 'local',
  analyzedAt: 1792544400,
};
const settings = { readFromFirstUnread: false, autoFollowLatestMessages: !params.has('no-follow') };
const invalidate = async () => undefined;
const utils = {
  account: {
    intentSense: {
      getProfile: { invalidate },
      getStatus: { invalidate },
      getSuggestions: { invalidate },
    },
  },
};
function useStatus() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 250);
    return () => clearTimeout(timer);
  }, []);
  return {
    data: ready
      ? { enabled: true, engine: 'local', localReady: true, persistentDisplay: true }
      : undefined,
    isLoading: !ready,
    isFetching: !ready,
  };
}
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useUtils') return () => utils;
      const name = path.at(-1);
      if (key === 'useQuery') {
        if (name === 'getStatus') return useStatus;
        return () => ({ data: name === 'getSettings' ? settings : undefined, isLoading: false });
      }
      if (key === 'useMutation')
        return () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false });
      if (key === 'query' && name === 'listMessageAnalyses') return async () => [result];
      if (key === 'mutate' && name === 'ensureAnalysis')
        return async () => ({ analyzed: 1, latestMsgId: latestId });
      if (key === 'query' || key === 'fetch' || key === 'invalidate') return async () => undefined;
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
