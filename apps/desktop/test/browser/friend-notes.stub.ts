import { useEffect, useSyncExternalStore } from 'react';

let requests = 0;
let writes = 0;
let fail = false;
let notes = {
  uid: 'u_peer',
  exists: true,
  revision: 'r1',
  company: '我备注的合成公司',
  phones: ['10086', '10010'],
  descriptions: ['我写的第一段说明', '第二项说明\n保留分行'],
};
let snapshot = { data: notes, error: null as Error | null };
const listeners = new Set<() => void>();
const publish = () => {
  snapshot = { data: notes, error: fail ? new Error('我的好友备注资料读取失败（151）') : null };
  for (const listener of listeners) listener();
};
const refetch = async () => {
  requests++;
  publish();
  return snapshot;
};
function useQuery(_input: unknown, options: { enabled: boolean }) {
  useEffect(() => {
    if (options.enabled) void refetch();
  }, [options.enabled]);
  const result = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
  );
  return {
    ...result,
    data: options.enabled ? result.data : undefined,
    isFetching: false,
    isLoading: false,
    refetch,
  };
}
export const trpc = {
  account: {
    qqWrite: {
      friendNotesState: { useQuery },
      friendNotes: {
        useMutation: () => ({
          mutateAsync: async (input: {
            notes: Pick<typeof notes, 'company' | 'phones' | 'descriptions'>;
          }) => {
            writes++;
            notes = { ...notes, ...input.notes, revision: `r${writes + 1}` };
            return { state: 'accepted' as const };
          },
        }),
      },
    },
  },
};
Object.assign(window, {
  friendNotesQa: {
    requests: () => requests,
    writes: () => writes,
    fail(value: boolean) {
      fail = value;
      publish();
    },
  },
});
