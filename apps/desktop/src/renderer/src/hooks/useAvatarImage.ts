import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from 'react';
import { cachedAvatarUrl, qqAvatarIdentity, qqAvatarIdentityForUin } from '../lib/avatarCache';
import { avatarRecovery, type AvatarSuccess } from '../lib/avatarRecovery';
import { dataSaverActive } from '../lib/dataSaver';
import { thumbnailPolicyRequest } from '../lib/resourceUrl';
import { webAvatarCache, webAvatarKey } from '../lib/webAvatarCache';
import { MessageImageContext } from '../lib/messageImageContext';

export const WebAvatarScope = createContext<string | null>(null);
const noSubscription = () => () => {};

/** 头像缓存独立于页面与正文；屏外节点不发起图片请求。 */
export function useAvatarImage(
  source: string | null | undefined,
  options?: { original?: string | null; uin?: string | null; identitySource?: string | null },
) {
  const { original, uin, identitySource = source } = options ?? {};
  const scope = useContext(WebAvatarScope);
  const messageImage = useContext(MessageImageContext);
  const key = scope && source ? webAvatarKey(scope, source) : null;
  const originalUrl = key && original ? cachedAvatarUrl(original) : null;
  const originalKey = scope && originalUrl ? webAvatarKey(scope, originalUrl) : null;
  const fallbackKey = originalKey !== key ? originalKey : null;
  const [image, ref] = useState<HTMLImageElement | null>(null);
  const [target, observeRef] = useState<HTMLElement | null>(null);
  const [loadedSource, setLoadedSource] = useState<string>();
  const [failedSource, setFailedSource] = useState<string>();
  const [rejectedRecovery, setRejectedRecovery] = useState<AvatarSuccess>();
  const identity = qqAvatarIdentity(identitySource) ?? qqAvatarIdentityForUin(uin);
  const revision = /[?&]_weq_avatar_remote=1(?:&|$)/.test(identitySource ?? '')
    ? identitySource?.match(/[?&]_weq_avatar_refresh=(\d+)/)?.[1]
    : undefined;
  const recoveryKey = identity && source ? JSON.stringify([scope, identity, revision]) : null;
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
  const preferred = key ? snapshot?.src : (source ?? undefined);
  const preferredFailed = Boolean(snapshot?.failed || (preferred && failedSource === preferred));
  const needsRecovery = preferredFailed || Boolean(key && !snapshot?.ready);
  const subscribeRecovery = useCallback(
    (listener: () => void) =>
      recoveryKey && needsRecovery
        ? avatarRecovery.subscribe(recoveryKey, listener)
        : noSubscription(),
    [recoveryKey, needsRecovery],
  );
  const recovery = useSyncExternalStore(
    subscribeRecovery,
    () => (recoveryKey && needsRecovery ? avatarRecovery.peek(recoveryKey) : undefined),
    () => undefined,
  );
  const candidate = recovery !== rejectedRecovery ? recovery : undefined;
  // 图片节点失败不等于已解码的共享图片失效；同一个缓存键也可重新挂载一次。
  const reuseKey = candidate?.webKey;
  const subscribeReuse = useCallback(
    (listener: () => void) =>
      reuseKey && reuseKey !== key && reuseKey !== fallbackKey
        ? webAvatarCache.subscribe(reuseKey, listener)
        : noSubscription(),
    [reuseKey, key, fallbackKey],
  );
  const reused = useSyncExternalStore(
    subscribeReuse,
    () => (reuseKey ? webAvatarCache.peek(reuseKey) : undefined),
    () => undefined,
  );
  const direct = candidate && !reuseKey ? candidate.src : undefined;
  let recoveredSrc = reused?.src ?? direct;
  if (direct && dataSaverActive()) {
    recoveredSrc = /^(weq-media:|weq-avatar:)/.test(direct)
      ? thumbnailPolicyRequest(direct).src
      : undefined;
  }
  const src = recoveredSrc ?? preferred;
  const loaded = Boolean(
    src && ((!preferredFailed && snapshot?.ready) || reused?.ready || loadedSource === src),
  );
  const failed = preferredFailed && !recoveredSrc;

  useEffect(() => {
    if (!key || !recoveryKey || !snapshot?.ready || !snapshot.src) return;
    const webKey = webAvatarCache.peek(key) === snapshot ? key : fallbackKey;
    if (webKey) avatarRecovery.remember(recoveryKey, { src: snapshot.src, webKey });
  }, [key, recoveryKey, snapshot, fallbackKey]);

  useLayoutEffect(() => {
    setFailedSource(undefined);
    setRejectedRecovery(undefined);
  }, [preferred, source, recoveryKey]);
  useLayoutEffect(() => {
    setLoadedSource(image?.complete && image.naturalWidth > 0 ? src : undefined);
  }, [image, src]);
  const observed = target ?? image;
  useEffect(() => {
    if ((!key && !reuseKey) || !source || !observed) return;
    const doc = observed.ownerDocument;
    const Observer = messageImage ? undefined : doc.defaultView?.IntersectionObserver;
    let visible = !Observer;
    let release: (() => void) | undefined;
    let releaseOriginal: (() => void) | undefined;
    let releaseReuse: (() => void) | undefined;
    const isVisible = () => visible && (messageImage || doc.visibilityState !== 'hidden');
    const refreshOriginal = () => {
      if (!key || !fallbackKey || !originalUrl) return;
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
    const unsubscribe =
      key && fallbackKey ? webAvatarCache.subscribe(key, refreshOriginal) : undefined;
    const refresh = () => {
      if (isVisible()) {
        if (key) {
          release ??= webAvatarCache.activate(key);
          void webAvatarCache.load(key, source);
        }
        if (reuseKey && reuseKey !== key) releaseReuse ??= webAvatarCache.activate(reuseKey);
      } else {
        release?.();
        release = undefined;
        releaseReuse?.();
        releaseReuse = undefined;
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
      releaseReuse?.();
    };
  }, [key, source, observed, fallbackKey, originalUrl, reuseKey, messageImage]);
  return {
    src,
    // 同地址也要换掉失败的 DOM 节点，否则浏览器不会重新加载。
    retryKey: recoveredSrc === preferred ? recoveredSrc : undefined,
    ref,
    observeRef,
    loaded,
    failed,
    onLoad: () => {
      if (!src) return;
      setLoadedSource(src);
      // 主页临时 Blob 归该组件所有，只有已复核的 CDN 地址可供别处复用。
      const reusable = src.startsWith('blob:') ? identitySource : src;
      if (
        !preferredFailed &&
        !key &&
        recoveryKey &&
        reusable &&
        /^(https?:|weq-media:|weq-avatar:)/.test(reusable)
      )
        avatarRecovery.remember(recoveryKey, { src: reusable });
    },
    onError: () => {
      if (!src) return;
      setLoadedSource(undefined);
      if (recoveredSrc) setRejectedRecovery(candidate);
      else setFailedSource(src);
    },
  };
}
