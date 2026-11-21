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
import { dataSaverActive } from '../lib/dataSaver';
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
    let releaseOriginal: (() => void) | undefined;
    const isVisible = () => visible && doc.visibilityState !== 'hidden';
    const refreshOriginal = () => {
      if (!fallbackKey || !originalUrl) return;
      const preferred = webAvatarCache.peek(key);
      if (isVisible() && !preferred?.ready) {
        const ready = webAvatarCache.peek(fallbackKey)?.ready;
        // 正常优先小图；缺图时才补取原图，省流量模式仅复用已有原图。
        if (!releaseOriginal && (ready || (preferred?.failed && !dataSaverActive()))) {
          releaseOriginal = webAvatarCache.activate(fallbackKey);
          if (!ready) void webAvatarCache.load(fallbackKey, originalUrl);
        }
      } else {
        const deactivate = releaseOriginal;
        releaseOriginal = undefined;
        deactivate?.();
      }
    };
    const unsubscribe = fallbackKey ? webAvatarCache.subscribe(key, refreshOriginal) : undefined;
    const refresh = () => {
      if (isVisible()) {
        release ??= webAvatarCache.activate(key);
        void webAvatarCache.load(key, source);
      } else {
        release?.();
        release = undefined;
      }
      refreshOriginal();
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
      unsubscribe?.();
      release?.();
      releaseOriginal?.();
    };
  }, [key, source, observed, fallbackKey, originalUrl]);
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
