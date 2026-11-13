import { useEffect, useRef } from 'react';

/** 仅真正进入聊天视口的缺口触发；虚拟列表预渲染的离屏条目不发请求。 */
export function useVisibleMessageGap(
  enabled: boolean,
  key: string | undefined,
  fetch: () => Promise<void>,
) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef(fetch);
  latest.current = fetch;
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element || typeof IntersectionObserver === 'undefined') return;
    let requested = false;
    let disposed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          disposed ||
          requested ||
          document.visibilityState === 'hidden' ||
          !entries.some((entry) => entry.isIntersecting)
        )
          return;
        requested = true;
        observer.disconnect();
        void latest.current();
      },
      { root: element.closest('.message-scroll') },
    );
    observer.observe(element);
    const resume = () => {
      if (requested || document.visibilityState === 'hidden') return;
      observer.unobserve(element);
      observer.observe(element);
    };
    document.addEventListener('visibilitychange', resume);
    return () => {
      disposed = true;
      observer.disconnect();
      document.removeEventListener('visibilitychange', resume);
    };
  }, [enabled, key]);
  return ref;
}
