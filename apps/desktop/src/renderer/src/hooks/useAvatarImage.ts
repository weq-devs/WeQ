import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { cachedAvatarUrl } from '../lib/avatarCache';
import { webAvatarCache, webAvatarKey } from '../lib/webAvatarCache';

export const WebAvatarScope = createContext<string | null>(null);
const noSubscription = () => () => {};

/** 头像缓存独立于页面与正文；屏外节点不发起图片请求。 */
export function useAvatarImage(source: string | null | undefined, original?: string | null) {
  const scope = useContext(WebAvatarScope);
  const key = scope && source ? webAvatarKey(scope, source) : null;
  const originalUrl = key && original ? cachedAvatarUrl(original) : null;
  const originalKey = scope && originalUrl ? webAvatarKey(scope, originalUrl) : null;
  const fallbackKey = originalKey !== key ? originalKey : null;
  const [image, ref] = useState<HTMLImageElement | null>(null);
  const [target, observeRef] = useState<HTMLElement | null>(null);
  const [loadedSource, setLoadedSource] = useState<string>();
  const [failedSource, setFailedSource] = useState<string>();
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return noSubscription();
      const unsubscribe = webAvatarCache.subscribe(key, listener);
      if (!fallbackKey) return unsubscribe;
      // 名片已成功解码的同一头像可以填补列表占位，复用时不请求原图。
      const unsubscribeFallback = webAvatarCache.subscribe(fallbackKey, listener);
      return () => {
        unsubscribe();
        unsubscribeFallback();
      };
    },
    [key, fallbackKey],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (key ? webAvatarCache.peek(key, fallbackKey) : undefined),
    () => undefined,
  );
  const src = key ? snapshot?.src : (source ?? undefined);
  const loaded = Boolean(src && (snapshot?.ready || loadedSource === src));
  const failed = Boolean(snapshot?.failed || (src && failedSource === src));

  useLayoutEffect(() => {
    setFailedSource(undefined);
  }, [src]);
  useLayoutEffect(() => {
    setLoadedSource(image?.complete && image.naturalWidth > 0 ? src : undefined);
  }, [image, src]);
  const observed = target ?? image;
  useEffect(() => {
    if (!key || !source || !observed) return;
    const doc = observed.ownerDocument;
    const Observer = doc.defaultView?.IntersectionObserver;
    let visible = !Observer;
    let release: (() => void) | undefined;
    const refresh = () => {
      if (visible && doc.visibilityState !== 'hidden') {
        release ??= webAvatarCache.activate(key);
        void webAvatarCache.load(key, source);
      } else {
        release?.();
        release = undefined;
      }
    };
    const observer = Observer
      ? new Observer((entries) => {
          visible = entries.some((entry) => entry.isIntersecting);
          refresh();
        })
      : null;
    observer?.observe(observed);
    doc.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      observer?.disconnect();
      doc.removeEventListener('visibilitychange', refresh);
      release?.();
    };
  }, [key, source, observed]);
  return {
    src,
    ref,
    observeRef,
    loaded,
    failed,
    onLoad: () => {
      if (src) setLoadedSource(src);
    },
    onError: () => {
      if (src) setFailedSource(src);
    },
  };
}
