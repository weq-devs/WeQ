import { useEffect, useSyncExternalStore } from 'react';
import type {
  QQWriteBinding,
  QQWriteOutcome,
} from '../../src/renderer/src/hooks/useQQWriteSession';

export const client = {};

type Input = QQWriteBinding & { groupId: number; uid: string };
type Mode = 'default' | 'concerned' | 'shielded';
let revision = 0;
const listeners = new Set<() => void>();
const cache = new Map<
  string,
  {
    groupId: number;
    uid: string;
    memberUin: string;
    mode: Mode | null;
    rawMode: number | null;
    complete: boolean;
  }
>();
const pending = new Set<string>();
const changed = () => {
  revision++;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const key = (input: Input) => JSON.stringify(input);
const counters = { reads: 0, writes: 0, checks: 0 };
let online = true;
let failure = false;
let unknown = false;
let failWrite = false;
let mismatch = false;
let account = '10001';
let config = 'qa';
let chosen: Mode = 'default';
async function load(input: Input) {
  counters.reads++;
  pending.add(key(input));
  changed();
  await new Promise((resolve) => setTimeout(resolve, 30));
  pending.delete(key(input));
  const data = {
    groupId: input.groupId,
    uid: input.uid,
    memberUin: '456',
    mode: unknown ? null : chosen,
    rawMode: unknown ? 99 : chosen === 'default' ? 0 : chosen === 'concerned' ? 1 : 2,
    complete: !unknown,
  };
  cache.set(key(input), data);
  changed();
  return { data, error: failure ? new Error('合成读取失败') : null };
}
function useQuery(input: Input, options: { enabled: boolean }) {
  useSyncExternalStore(subscribe, () => revision);
  const id = key(input);
  useEffect(() => {
    if (options.enabled && !cache.has(id) && !pending.has(id)) void load(input);
  }, [id, options.enabled, input]);
  return {
    data: cache.get(id),
    isFetching: pending.has(id),
    error: failure ? new Error('合成读取失败') : null,
    refetch: () => load(input),
  };
}
export const trpc = {
  account: {
    qqWrite: {
      groupMemberNotifyState: { useQuery },
      groupMemberNotify: {
        useMutation: () => ({
          mutateAsync: async (input: Input & { mode: Mode }) => {
            counters.writes++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            if (failWrite) throw new Error('合成保存失败');
            if (!mismatch) chosen = input.mode;
            return { state: 'accepted' as const };
          },
        }),
      },
    },
  },
};
export function useQQWriteSession() {
  useSyncExternalStore(subscribe, () => revision);
  const binding = { expectedAccountUin: account, expectedAccountConfigId: config };
  return {
    binding,
    available: online,
    busy: false,
    run: async (
      action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
      _refresh?: unknown,
      options?: { requireReadback?: boolean; readback?: () => Promise<boolean> },
    ) => {
      try {
        await action(binding);
        if (account !== binding.expectedAccountUin || config !== binding.expectedAccountConfigId)
          return false;
        counters.checks++;
        return (await options?.readback?.()) ?? false;
      } catch {
        return false;
      }
    },
  };
}
export const qa = {
  counters,
  reset: () => {
    online = true;
    failure = false;
    unknown = false;
    failWrite = false;
    mismatch = false;
    account = '10001';
    config = 'qa';
    chosen = 'default';
    cache.clear();
    pending.clear();
    Object.assign(counters, { reads: 0, writes: 0, checks: 0 });
    changed();
  },
  configure: (value: {
    online?: boolean;
    failure?: boolean;
    unknown?: boolean;
    failWrite?: boolean;
    mismatch?: boolean;
    account?: string;
    config?: string;
  }) => {
    online = value.online ?? online;
    failure = value.failure ?? failure;
    unknown = value.unknown ?? unknown;
    failWrite = value.failWrite ?? failWrite;
    mismatch = value.mismatch ?? mismatch;
    account = value.account ?? account;
    config = value.config ?? config;
    changed();
  },
};
