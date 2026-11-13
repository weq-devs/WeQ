import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { AnimationItem } from 'lottie-web';
import { useTabActive } from '../components/RetainedTabs';
import { useRenderDocument } from '../lib/renderDocument';
import { useNearViewport } from './useNearViewport';

/** 只暂停离屏动画，不卸载播放器或清空当前帧，预挂载内容仍可立即绘制。 */
export function useLottiePlayback(container: RefObject<HTMLElement | null>, enabled = true) {
  const { near } = useNearViewport(container, { enabled });
  const tabActive = useTabActive();
  const document = useRenderDocument();
  const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden');
  const active = useRef(false);
  const current = useRef<{ animation?: AnimationItem; finished: boolean }>({ finished: false });
  const sync = useCallback(() => {
    const { animation, finished } = current.current;
    if (!animation) return;
    if (active.current && !finished) animation.play();
    else animation.pause();
  }, []);
  const complete = useCallback(() => {
    // 骰子等交互表情的最终结果停在末帧，重新可见不能把它再次启动。
    current.current.finished = true;
  }, []);
  const bindAnimation = useCallback(
    (animation?: AnimationItem) => {
      const previous = current.current.animation;
      if (previous === animation) return;
      previous?.removeEventListener('complete', complete);
      previous?.pause();
      current.current = { animation, finished: false };
      animation?.addEventListener('complete', complete);
      sync();
    },
    [complete, sync],
  );

  useEffect(() => {
    if (!enabled) return;
    const update = () => setDocumentVisible(document.visibilityState !== 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [document, enabled]);
  useLayoutEffect(() => {
    active.current = enabled && near && tabActive && documentVisible;
    sync();
  }, [enabled, near, tabActive, documentVisible, sync]);
  useEffect(() => () => bindAnimation(), [bindAnimation]);

  return bindAnimation;
}
