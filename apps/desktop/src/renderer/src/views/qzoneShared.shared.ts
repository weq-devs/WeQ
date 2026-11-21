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

/** 当前页是否可见 + 刷新代数（供子组件决定是否继续读）。 */
export const QzonePageContext = createContext({ active: true, refresh: 0 });
/** 上游明确不可用时暂停自动读取，保留已读内容。 */
export const QzoneReadPauseContext = createContext(false);

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
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setNear(visible);
        if (visible && once) observer.disconnect();
      },
      { root: element.closest('.weq-qzn-scroll'), rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, once, active, enabled]);
  return active && enabled && near;
}
