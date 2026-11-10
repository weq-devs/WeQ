import { useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';

type OnlineStatus = NonNullable<Awaited<ReturnType<typeof client.account.getOnlineStatus.query>>>;

/** 仅联系人页需要在线状态；短时间重进复用结果，离开后停止补后续批次。 */
export function useContactOnlineStatuses(
  buddies: readonly { uid: string }[] | undefined,
  active: boolean,
) {
  const [statuses, setStatuses] = useState<Record<string, OnlineStatus>>({});
  const checkedAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!active) return;
    const targets = (buddies ?? [])
      .slice(0, 300)
      .filter((buddy) => Date.now() - (checkedAt.current.get(buddy.uid) ?? 0) >= 60_000);
    let cancelled = false;
    void (async () => {
      for (let index = 0; index < targets.length && !cancelled; index += 12) {
        const batch = await Promise.all(
          targets.slice(index, index + 12).map(async ({ uid }) => {
            try {
              return { uid, status: await client.account.getOnlineStatus.query({ uid }) };
            } catch {
              return null;
            }
          }),
        );
        if (cancelled) return;
        const next: Record<string, OnlineStatus> = {};
        for (const result of batch) {
          if (!result) continue;
          checkedAt.current.set(result.uid, Date.now());
          if (result.status) next[result.uid] = result.status;
        }
        if (Object.keys(next).length) setStatuses((current) => ({ ...current, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buddies, active]);
  return statuses;
}
