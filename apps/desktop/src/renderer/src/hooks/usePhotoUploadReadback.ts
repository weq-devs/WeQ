import { useEffect, useRef, useState } from 'react';
import { useQQReadActivity } from './useQQAutoRefresh';

/** 仅核对已上传的照片，不重发上传；隐藏、切页或已观察到照片后停止等待。 */
export function usePhotoUploadReadback(
  scope: string,
  pendingIds: string[],
  available: boolean,
  refresh: () => Promise<unknown>,
) {
  const activity = useQQReadActivity(available && pendingIds.length > 0);
  const pendingKey = JSON.stringify([...new Set(pendingIds)].sort());
  const read = useRef(refresh);
  read.current = refresh;
  const inFlight = useRef<{ scope: string; promise: Promise<unknown> } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  useEffect(() => {
    setExhausted(false);
    if (!activity.enabled || pendingKey === '[]') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const delays = [1000, 2000, 4000];
    const schedule = (index: number) => {
      timer = setTimeout(async () => {
        const promise =
          inFlight.current?.scope === scope
            ? inFlight.current.promise
            : Promise.resolve().then(() => read.current());
        inFlight.current = { scope, promise };
        try {
          await promise;
        } catch {
          // 读取失败仍只消耗本轮核对次数，不改变上传完成状态。
        } finally {
          if (inFlight.current?.promise === promise) inFlight.current = null;
        }
        if (!live) return;
        if (index + 1 < delays.length) schedule(index + 1);
        else setExhausted(true);
      }, delays[index]);
    };
    schedule(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scope, pendingKey, activity.enabled, activity.revision, attempt]);
  return {
    exhausted: exhausted && pendingIds.length > 0,
    retry: () => setAttempt((value) => value + 1),
  };
}
