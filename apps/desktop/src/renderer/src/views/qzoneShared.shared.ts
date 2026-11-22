/**
 * 空间页与空友爱看共用的展示件。
 *
 * 这两套内容来自完全不同的协议（旧空间 web cgi 的 HTML 片段 vs. 爱看的 `cell_*`
 * 结构），但「页面容器 / 视口懒加载 / 媒体网格 / 预览 / 加载与错误态」是同一套交互，
 * 所以抽在这里共用，避免两份实现慢慢漂移。
 *
 * 样式仍走 `styles/qzone.css` 的 `weq-qzn-*` 类名。
 */
import { createContext, useContext, useEffect, useState, type RefObject } from 'react';

export const moreSpacePanes = {
  shares: '分享',
  visitors: '访客',
  guestbook: '留言板',
  videos: '视频',
};
export type QzoneMorePane = keyof typeof moreSpacePanes;

/** 当前页是否可见 + 刷新代数（供子组件决定是否继续读）。 */
export const QzonePageContext = createContext({ active: true, refresh: 0 });
/** 上游明确不可用时暂停自动读取，保留已读内容。 */
export const QzoneReadPauseContext = createContext(false);

type VisibilityListener = (near: boolean) => void;
type ViewportTarget = { near?: boolean; listeners: Set<VisibilityListener> };
type ViewportPool = { observer: IntersectionObserver; targets: Map<Element, ViewportTarget> };
const viewportPools = new WeakMap<Document | Element, ViewportPool>();

function observeNearViewport(
  element: HTMLElement,
  once: boolean,
  setNear: VisibilityListener,
): (() => void) | undefined {
  const document = element.ownerDocument;
  const Observer = document.defaultView?.IntersectionObserver;
  if (!Observer) {
    setNear(true);
    return;
  }
  const root = element.closest('.weq-qzn-scroll');
  const key = root ?? document;
  let pool = viewportPools.get(key);
  if (!pool) {
    const targets = new Map<Element, ViewportTarget>();
    const observer = new Observer(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          const observation = targets.get(target);
          if (!observation) continue;
          observation.near = isIntersecting;
          for (const listener of observation.listeners) listener(isIntersecting);
        }
      },
      { root, rootMargin: '300px' },
    );
    pool = { observer, targets };
    viewportPools.set(key, pool);
  }
  const { observer, targets } = pool;
  let target = targets.get(element);
  if (!target) {
    target = { listeners: new Set() };
    targets.set(element, target);
    observer.observe(element);
  }
  const observation = target;
  const stop = () => {
    if (!observation.listeners.delete(notify) || observation.listeners.size) return;
    targets.delete(element);
    if (targets.size) observer.unobserve(element);
    else {
      observer.disconnect();
      viewportPools.delete(key);
    }
  };
  const notify = (near: boolean) => {
    if (near && once) stop();
    setNear(near);
  };
  observation.listeners.add(notify);
  if (observation.near !== undefined) notify(observation.near);
  return stop;
}

/** 元素是否进入（或接近）滚动容器视口；`once` 只触发一次。 */
export function useNearViewport(
  ref: RefObject<HTMLElement | null>,
  once = false,
  enabled = true,
): boolean {
  const [near, setNear] = useState(false);
  const { active } = useContext(QzonePageContext);
  useEffect(() => {
    if (!active || !enabled) {
      setNear(false);
      return undefined;
    }
    const element = ref.current;
    if (!element) return undefined;
    return observeNearViewport(element, once, setNear);
  }, [ref, once, active, enabled]);
  return active && enabled && near;
}
