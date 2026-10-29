/**
 * 列表预览视频的**并发播放闸门**。
 *
 * 光靠「进视口才挂 `<video>`」还不够:装扮页一屏能摆下二十来张卡片,通话背景那栏
 * 82 款又全是 mp4 —— 同时解码二十几路,GPU / 解码器直接吃满。这里给全页一个固定
 * 名额(见 {@link PLAYBACK_LIMIT}),抢到的才播,抢不到的停在封面图上。
 *
 * 名额随离屏卡片归还:滚动时旧卡片的 effect 清理会 release,排在队首的等待者补上 ——
 * 所以往下滚,动的永远是当前这一屏,不会攒住。
 *
 * 用模块级状态而不是 Context:装扮页只有这一处用到,没必要为它多铺一层 Provider。
 */

import { useEffect, useSyncExternalStore } from 'react';

/** 同时播放的路数上限。再高就回到「一屏全动但整页卡」的老问题。 */
export const PLAYBACK_LIMIT = 6;

const active = new Set<string>();
/** 等待名单,按申请顺序排 —— 大致就是列表从上到下的顺序。 */
const waiting: string[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 有空位就补,直到名额满或没人等。 */
function fill(): void {
  let changed = false;
  while (active.size < PLAYBACK_LIMIT && waiting.length > 0) {
    const next = waiting.shift()!;
    if (active.has(next)) continue;
    active.add(next);
    changed = true;
  }
  if (changed) emit();
}

function acquire(key: string): void {
  if (active.has(key) || waiting.includes(key)) return;
  if (active.size < PLAYBACK_LIMIT) {
    active.add(key);
    emit();
    return;
  }
  waiting.push(key);
}

function cancel(key: string): void {
  const at = waiting.indexOf(key);
  if (at >= 0) waiting.splice(at, 1);
}

function release(key: string): void {
  if (active.delete(key)) fill();
  else cancel(key);
}

/**
 * @param key 唯一标识(这里用 `kind:itemId`)。
 * @param wanted 调用方是否希望播放 —— 通常就是「这张卡片在视口内」。
 * @returns 现在是否真的该挂 `<video>`。
 */
export function useVideoPlaybackSlot(key: string, wanted: boolean): boolean {
  const playing = useSyncExternalStore(subscribe, () => active.has(key));

  useEffect(() => {
    if (!wanted) return;
    acquire(key);
    return () => release(key);
  }, [key, wanted]);

  // 名额在 effect 里申请,首帧先按封面渲染,拿到名额后的那次渲染才换成视频。
  return wanted && playing;
}
