import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { webAvatarCache, webAvatarKey } from '../lib/webAvatarCache';

export const WebAvatarScope = createContext<string | null>(null);
const noSubscription = () => () => {};

/** 头像缓存独立于页面与正文；屏外节点不发起图片请求。 */
export function useAvatarImage(source: string | null | undefined) {
  const scope = useContext(WebAvatarScope);
  const key = scope && source ? webAvatarKey(scope, source) : null;
  const [image, ref] = useState<HTMLImageElement | null>(null);
  const [loadedSource, setLoadedSource] = useState<string>();
  const [failedSource, setFailedSource] = useState<string>();
  const subscribe = useCallback(
    (listener: () => void) => (key ? webAvatarCache.subscribe(key, listener) : noSubscription()),
    [key],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (key ? webAvatarCache.peek(key) : undefined),
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
  useEffect(() => {
    if (!key || !source || (!image && !snapshot?.failed)) return;
    const doc = image?.ownerDocument ?? document;
    const Observer = doc.defaultView?.IntersectionObserver;
    let visible = !image || !Observer;
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
    const observer =
      Observer && image
        ? new Observer((entries) => {
            visible = entries.some((entry) => entry.isIntersecting);
            refresh();
          })
        : null;
    if (image) observer?.observe(image);
    doc.addEventListener('visibilitychange', refresh);
    refresh();
    return () => {
      observer?.disconnect();
      doc.removeEventListener('visibilitychange', refresh);
      release?.();
    };
  }, [key, source, image, snapshot?.failed]);
  return {
    src,
    ref,
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
