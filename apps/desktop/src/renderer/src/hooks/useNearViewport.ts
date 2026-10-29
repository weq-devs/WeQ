/**
 * 元素是否接近视口 —— 由 IntersectionObserver 驱动，给长列表里的媒体按需加载用。
 *
 * 返回两个值，因为「图片」和「视频」要的策略不一样：
 *
 *  - `near`：当前是否在（含 rootMargin 的）视口范围内。视频用它 —— 离屏就卸载，
 *    否则几十张卡各挂一路 autoPlay，解码器会一直吃 GPU。
 *  - `entered`：是否**曾经**进入过。图片用它 —— 取过一次就保留 `src`，滚回来
 *    不必再走一遍主进程代理。
 *
 * `rootSelector` 把观察根限定到滚动容器（卡片在 `.weq-dress-body` 里滚），
 * 不传或找不到时退回视口。没有 IntersectionObserver 的环境直接当成一直可见 ——
 * 宁可多取，也别让内容永远停在占位上。
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface NearViewportState {
  /** 当前是否在观察根（含 rootMargin）范围内。 */
  near: boolean;
  /** 是否曾经进入过 —— 一旦为 true 不再回退。 */
  entered: boolean;
}

export function useNearViewport(
  ref: RefObject<Element | null>,
  opts: { rootSelector?: string; rootMargin?: string } = {},
): NearViewportState {
  const { rootSelector, rootMargin = '200px' } = opts;
  const [near, setNear] = useState(false);
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const Observer = element.ownerDocument.defaultView?.IntersectionObserver;
    if (!Observer) {
      setNear(true);
      enteredRef.current = true;
      setEntered(true);
      return;
    }
    const observer = new Observer(
      ([entry]) => {
        const intersecting = entry?.isIntersecting ?? false;
        setNear(intersecting);
        if (intersecting && !enteredRef.current) {
          enteredRef.current = true;
          setEntered(true);
        }
      },
      { root: rootSelector ? element.closest(rootSelector) : null, rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootSelector, rootMargin]);

  return { near, entered };
}
