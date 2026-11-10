import { useEffect, useState } from 'react';
import { client } from '../trpc/client';
import { useViewState } from '../state/view';

/** 名片先显示传入的本地资料；云端投影仅保留在名片生命周期内。 */
export function useCardDisplayNames(kind: 'user' | 'group', target: string, enabled = true) {
  const account = useViewState((state) => state.openedUin);
  const key = JSON.stringify([account, kind, target, enabled]);
  const [result, setResult] = useState<{ key: string; name: string; remark?: string }>();
  useEffect(() => {
    if (!enabled || !/^[1-9]\d{0,9}$/.test(target)) return;
    let active = true;
    void (async () => {
      try {
        const names = await client.account.getCardDisplayNames.query({ kind, target });
        if (active) setResult({ key, ...names });
      } catch {
        // 读不到云端时保持本地首屏，不清空已有资料。
      }
    })();
    return () => {
      active = false;
    };
  }, [key, kind, target, enabled]);
  return result?.key === key ? result : undefined;
}
