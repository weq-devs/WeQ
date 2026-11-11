import { useEffect, useSyncExternalStore } from 'react';
import {
  PROFILE_DISPLAY_FIELDS,
  PROFILE_DISPLAY_KEYS,
  type ProfileDisplayField,
} from '@weq/protocol/profile-display';
import { trpc as base, useQQWriteSession, client } from './self-profile.stub';
export { useQQWriteSession, client };

let version = 0;
let loaded = false;
let loading = false;
let failure = false;
let calls = 0;
let writes = 0;
let mismatch = false;
const account = '10001';
const values = new Map<ProfileDisplayField, number>();
const listeners = new Set<() => void>();
const notify = () => {
  version++;
  for (const listener of listeners) listener();
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
function result() {
  return {
    targetUin: account,
    settings: PROFILE_DISPLAY_KEYS.map((field) => {
      const raw = values.get(field) ?? 0;
      const option = PROFILE_DISPLAY_FIELDS[field].options.find((option) => option.raw === raw);
      return {
        field,
        raw,
        value: option?.value ?? null,
        status: option ? ('known' as const) : ('unknown' as const),
      };
    }),
  };
}
async function load() {
  calls++;
  loading = true;
  notify();
  await new Promise((resolve) => setTimeout(resolve, 300));
  loaded = true;
  loading = false;
  notify();
  return { data: result(), error: failure ? new Error('合成读取失败') : null };
}
function useDisplayQuery(_input: unknown, opts: { enabled: boolean }) {
  useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    if (opts.enabled && !loaded && !loading) void load();
  }, [opts.enabled]);
  return {
    data: loaded ? result() : undefined,
    isFetching: loading,
    error: failure ? new Error('合成读取失败') : null,
    refetch: load,
  };
}
export const trpc = {
  ...base,
  account: {
    ...base.account,
    qqWrite: {
      ...base.account.qqWrite,
      selfProfileDisplaySettings: { useQuery: useDisplayQuery },
      setSelfProfileDisplaySetting: {
        useMutation: () => ({
          mutateAsync: async (input: { field: ProfileDisplayField; value: number }) => {
            writes++;
            await new Promise((resolve) => setTimeout(resolve, 300));
            if (!mismatch)
              values.set(
                input.field,
                PROFILE_DISPLAY_FIELDS[input.field].options.find(
                  (option) => option.value === input.value,
                )!.raw,
              );
            const setting = result().settings.find((setting) => setting.field === input.field)!;
            return {
              targetUin: account,
              field: input.field,
              state: mismatch ? ('mismatch' as const) : ('confirmed' as const),
              setting,
              error: mismatch ? '读回状态与选择不一致，请重新读取核对' : null,
            };
          },
        }),
      },
    },
  },
};
export const qa = {
  calls: () => calls,
  writes: () => writes,
  mismatch: (value: boolean) => {
    mismatch = value;
  },
  fail: (value: boolean) => {
    failure = value;
    notify();
  },
  unknown: (field: ProfileDisplayField) => {
    values.set(field, 99);
    notify();
  },
};
