import { useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';
import { useQQWriteSession, type QQWriteBinding } from './useQQWriteSession';

export function isLookupNumber(keyword: string): boolean {
  return /^[1-9]\d{0,9}$/.test(keyword) && BigInt(keyword) <= 0xffffffffn;
}

export const NUMBER_LOOKUP_IDLE_MS = 1001;
export type NumberLookupProfile = Awaited<
  ReturnType<typeof client.account.qqWrite.exactProfile.query>
>;
type LookupState = { key: string; data?: NumberLookupProfile; error?: string };

function useProfileLookup(
  kind: 'user' | 'group',
  target: string,
  binding: QQWriteBinding | null,
  available: boolean,
) {
  const [revision, setRevision] = useState(0);
  const enabled = available && Boolean(binding) && isLookupNumber(target);
  const uin = binding?.expectedAccountUin;
  const configId = binding?.expectedAccountConfigId;
  const key = JSON.stringify([uin, configId, target, enabled, revision]);
  const latest = useRef(key);
  latest.current = key;
  const [state, setState] = useState<LookupState>({ key });
  useEffect(() => {
    setState({ key });
    if (!enabled || !uin || !configId) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void client.account.qqWrite.exactProfile
        .query({
          expectedAccountUin: uin,
          expectedAccountConfigId: configId,
          kind,
          target,
        })
        .then(
          (data) => {
            if (!cancelled && latest.current === key) setState({ key, data });
          },
          (error: unknown) => {
            if (!cancelled && latest.current === key)
              setState({ key, error: error instanceof Error ? error.message : '查询失败' });
          },
        );
    }, NUMBER_LOOKUP_IDLE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled, uin, configId, kind, target, key]);
  const current = enabled && state.key === key ? state : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: enabled && !current?.data && current?.error === undefined,
    retry: () => setRevision((value) => value + 1),
  };
}

export function useNumberLookup(
  keyword: string,
  kinds: readonly ('user' | 'group')[] = ['user', 'group'],
) {
  const session = useQQWriteSession('global-number-lookup');
  const target = keyword;
  const user = useProfileLookup(
    'user',
    target,
    session.binding,
    session.available && kinds.includes('user'),
  );
  const group = useProfileLookup(
    'group',
    target,
    session.binding,
    session.available && kinds.includes('group'),
  );
  return { available: session.available, user, group };
}
