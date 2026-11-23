type ImageReply = { type: string; base64: string };
type ImageWindow = Window & {
  weqRemoteLinks?: { loadQqImage?: (id: string, url: string) => void };
  webkit?: { messageHandlers?: { weqQqImage?: { postMessage(url: string): Promise<unknown> } } };
};

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif']);
let preferRemote = false;

export function setPreferRemoteImage(enabled: boolean) {
  preferRemote = enabled;
}

export function remoteImageAvailable() {
  const shell = typeof window === 'undefined' ? undefined : (window as ImageWindow);
  return Boolean(shell?.weqRemoteLinks?.loadQqImage || shell?.webkit?.messageHandlers?.weqQqImage);
}

export function remoteAvatarSource(source: string): string | null {
  if (!preferRemote || !remoteImageAvailable()) return null;
  const proxy = new URL(source, 'https://weq.invalid');
  if (proxy.pathname !== '/_media/avatar') return null;
  const fallback = proxy.searchParams.get('fb');
  if (!fallback) return null;
  try {
    const url = new URL(fallback);
    return url.protocol === 'https:' &&
      ((/^(thirdqq|q|q1|q2)\.qlogo\.cn$/.test(url.hostname) && url.pathname === '/g') ||
        (url.hostname === 'p.qlogo.cn' && url.pathname.startsWith('/gh/')))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** 原生桥取完整且有界的图片，旧壳或失败时不改变原有电脑路径。 */
export function requestRemoteImage(url: string, signal: AbortSignal): Promise<ImageReply | null> {
  return new Promise((resolve) => {
    const shell = window as ImageWindow;
    const ios = shell.webkit?.messageHandlers?.weqQqImage;
    const android = shell.weqRemoteLinks;
    if (signal.aborted || (!ios && !android?.loadQqImage)) return resolve(null);
    const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
      part.toString(16).padStart(8, '0'),
    ).join('');
    let done = false;
    const finish = (value: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      shell.removeEventListener('weq-remote-qq-image', receive);
      const reply = value as Partial<ImageReply> | null;
      resolve(
        reply?.type &&
          TYPES.has(reply.type) &&
          typeof reply.base64 === 'string' &&
          reply.base64.length > 0 &&
          reply.base64.length <= Math.ceil(MAX_BYTES / 3) * 4
          ? { type: reply.type, base64: reply.base64 }
          : null,
      );
    };
    const abort = () => finish(null);
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; image: unknown }>).detail;
      if (detail?.id === id) finish(detail.image);
    };
    const timer = setTimeout(abort, 5500);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (ios) void ios.postMessage(url).then(finish, abort);
      else {
        shell.addEventListener('weq-remote-qq-image', receive);
        android?.loadQqImage?.(id, url);
      }
    } catch {
      abort();
    }
  });
}
