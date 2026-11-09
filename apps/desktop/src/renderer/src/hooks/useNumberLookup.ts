import { useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';
import { useQQWriteSession, type QQWriteBinding } from './useQQWriteSession';

export function isLookupNumber(keyword: string): boolean {
  const number = keyword.trim();
  return /^[1-9]\d{0,9}$/.test(number) && BigInt(number) <= 0xffffffffn;
}

type Profile = Awaited<ReturnType<typeof client.account.qqWrite.exactProfile.query>>;
type LookupState = { key: string; data?: Profile; error?: string };

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
    }, 200);
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

export function useNumberLookup(keyword: string) {
  const session = useQQWriteSession('global-number-lookup');
  const target = keyword.trim();
  const user = useProfileLookup('user', target, session.binding, session.available);
  const group = useProfileLookup('group', target, session.binding, session.available);
  return { available: session.available, user, group };
}
