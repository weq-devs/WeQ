import { useEffect, useRef, useState } from 'react';
import { useTabActive } from '../components/RetainedTabs.shared';
import { client, trpc } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';

/** 群名片和成员菜单现算人数，仅在主动统计时补查个人线索。 */
export function useGroupFriendSources(groupCode: string) {
  const active = useTabActive();
  const { binding, available } = useQQWriteSession(`group-friend-sources:${groupCode}`, true);
  const enabled = active && Boolean(binding) && /^[1-9]\d{0,9}$/.test(groupCode);
  const scope = enabled ? JSON.stringify([binding, groupCode]) : '';
  const [collecting, setCollecting] = useState(false);
  const collectRun = useRef<AbortController | null>(null);
  useEffect(() => {
    setCollecting(false);
    return () => {
      collectRun.current?.abort();
      collectRun.current = null;
    };
  }, [scope]);

  const summary = trpc.account.contactMetrics.groupFriendSources.useQuery(
    { ...binding!, groupCode },
    { enabled, staleTime: 0, cacheTime: 0, retry: false, refetchOnWindowFocus: false },
  );
  const data = enabled ? summary.data : undefined;
  const incomplete = Boolean(data && (!data.rosterComplete || data.pendingUids.length));

  async function collect() {
    if (!enabled || !binding || collectRun.current || !available) return;
    const run = new AbortController();
    collectRun.current = run;
    setCollecting(true);
    try {
      const { data: current, isError } = await summary.refetch();
      if (!current || isError || run.signal.aborted) return;
      let next = 0;
      const worker = async () => {
        while (!run.signal.aborted && next < current.pendingUids.length) {
          const uid = current.pendingUids[next++]!;
          await client.account.qqWrite.friendClue
            .query({ ...binding, uid }, { signal: run.signal })
            .catch(() => undefined);
        }
      };
      await Promise.all([worker(), worker()]);
      if (!run.signal.aborted) await summary.refetch();
    } finally {
      if (collectRun.current === run) {
        collectRun.current = null;
        if (!run.signal.aborted) setCollecting(false);
      }
    }
  }

  const count = data ? `${data.addedUids.length}${incomplete || data.unknown ? '+' : ''}` : '';
  const text = collecting
    ? '统计中…'
    : data
      ? `${count}${incomplete ? '（点击统计）' : ''}`
      : summary.isError
        ? '读取失败，点击重试'
        : '读取中…';
  const disabled = !enabled || collecting || (data ? incomplete && !available : !summary.isError);

  return {
    data,
    scope,
    text,
    settled: Boolean(data && !incomplete && !collecting),
    disabled,
    reason: incomplete && !available ? 'QQ 在线后可补齐好友线索' : undefined,
    activate(openList: () => void) {
      if (disabled) return;
      if (!data) void summary.refetch();
      else if (incomplete) void collect();
      else openList();
    },
  };
}
