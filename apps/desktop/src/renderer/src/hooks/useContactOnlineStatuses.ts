import { useEffect, useRef, useState } from 'react';
import { client } from '../trpc/client';

type OnlineStatus = NonNullable<Awaited<ReturnType<typeof client.account.getOnlineStatus.query>>>;

/** 仅联系人页需要在线状态；短时间重进复用结果，离开后停止补后续批次。 */
export function useContactOnlineStatuses(
  contacts: readonly { uid: string }[] | undefined,
  active: boolean,
  limit = 300,
) {
  const [statuses, setStatuses] = useState<Record<string, OnlineStatus>>({});
  const [loading, setLoading] = useState(false);
  const checkedAt = useRef(new Map<string, number>());
  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }
    const targets = (contacts ?? [])
      .slice(0, limit)
      .filter((buddy) => Date.now() - (checkedAt.current.get(buddy.uid) ?? 0) >= 60_000);
    setLoading(targets.length > 0);
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
        const reads = batch.filter((result) => result !== null);
        const now = Date.now();
        for (const { uid } of reads) checkedAt.current.set(uid, now);
        setStatuses((current) => {
          const changes = reads.filter(({ uid, status }) => status || Object.hasOwn(current, uid));
          if (!changes.length) return current;
          const next = { ...current };
          for (const { uid, status } of changes) {
            if (status) next[uid] = status;
            else delete next[uid];
          }
          return next;
        });
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [contacts, active, limit]);
  return { statuses, loading };
}
