type ImageWindow = Window & {
  weqRemoteLinks?: {
    loadQqImage?: (id: string, url: string) => void;
    loadQqImageBinary?: (id: string, url: string) => void;
    supportsBinaryImages?: () => boolean;
    supportsDressImages?: () => boolean;
  };
  weqRemoteDressImages?: boolean;
  weqRemoteBinaryImages?: boolean;
  webkit?: {
    messageHandlers?: {
      weqQqImage?: { postMessage(request: string | { url: string; id: string }): Promise<unknown> };
    };
  };
};

const MAX_BYTES = 2 * 1024 * 1024;
const TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/apng',
  'image/gif',
  'image/webp',
  'image/avif',
]);
let preferRemote = false;

export function setPreferRemoteImage(enabled: boolean) {
  preferRemote = enabled;
}

export function remoteImageAvailable() {
  const shell = typeof window === 'undefined' ? undefined : (window as ImageWindow);
  return Boolean(shell?.weqRemoteLinks?.loadQqImage || shell?.webkit?.messageHandlers?.weqQqImage);
}

export function remoteDressImageAvailable() {
  const shell = typeof window === 'undefined' ? undefined : (window as ImageWindow);
  return Boolean(
    remoteImageAvailable() &&
      (shell?.weqRemoteDressImages === true || shell?.weqRemoteLinks?.supportsDressImages),
  );
}

/** 只接电脑给出的名片和挂件成品图；默认广告与未知部件仍走原路径。 */
export function publicDressImage(proxy: URL): string | null {
  if (proxy.pathname !== '/_media/dress') return null;
  const src = proxy.searchParams.get('src');
  if (!src) return null;
  try {
    const url = new URL(src);
    const match =
      /^\/(?:card|faceAddon)\/item\/([0-9a-fA-F]{1,32})\/[a-zA-Z0-9_-]+\.(?:png|apng|jpe?g|gif|webp)$/.exec(
        url.pathname,
      );
    return url.origin === 'https://tianquan.gtimg.cn' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      match &&
      /[1-9a-fA-F]/.test(match[1]!)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function remoteDressImageSource(source: string): string | null {
  if (!remoteDressImageAvailable() || !source.startsWith('/_media/dress?')) return null;
  const proxy = new URL(source, 'https://weq.invalid');
  return proxy.searchParams.get('_weq_dress_direct') === '1' ? publicDressImage(proxy) : null;
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

const binaryImagePath = '/_weq-remote-local/image/';

/** 新壳通过环回提供原始字节，旧壳的 Base64 回复在这里统一还原为 Blob。 */
export function requestRemoteImage(url: string, signal: AbortSignal): Promise<Blob | null> {
  return new Promise((resolve) => {
    const shell = window as ImageWindow;
    const ios = shell.webkit?.messageHandlers?.weqQqImage;
    const android = shell.weqRemoteLinks;
    if (signal.aborted || (!ios && !android?.loadQqImage)) return resolve(null);
    const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) =>
      part.toString(16).padStart(8, '0'),
    ).join('');
    const path = binaryImagePath + id;
    const download = new AbortController();
    let done = false;
    let receiving = false;
    const finish = (blob: Blob | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      shell.removeEventListener('weq-remote-qq-image', receive);
      download.abort();
      resolve(blob?.size && blob.size <= MAX_BYTES && TYPES.has(blob.type) ? blob : null);
    };
    const accept = async (value: unknown) => {
      if (done || receiving) return;
      receiving = true;
      const reply = value as { path?: unknown; type?: unknown; base64?: unknown } | null;
      try {
        if (reply?.path === path) {
          const response = await fetch(path, {
            signal: download.signal,
            redirect: 'error',
            cache: 'no-store',
          });
          const length = Number(response.headers.get('Content-Length'));
          if (!response.ok || !(length > 0) || length > MAX_BYTES) return finish(null);
          const blob = await response.blob();
          return finish(blob.size === length ? blob : null);
        }
        if (
          typeof reply?.type === 'string' &&
          TYPES.has(reply.type) &&
          typeof reply.base64 === 'string' &&
          reply.base64.length > 0 &&
          reply.base64.length <= Math.ceil(MAX_BYTES / 3) * 4
        ) {
          const bytes = Uint8Array.from(atob(reply.base64), (char) => char.charCodeAt(0));
          return finish(new Blob([bytes], { type: reply.type }));
        }
      } catch {
        // 图片源失败仍使用电脑上的原路径。
      }
      finish(null);
    };
    const abort = () => finish(null);
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; image: unknown }>).detail;
      if (detail?.id === id) void accept(detail.image);
    };
    const timer = setTimeout(abort, 5500);
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (ios)
        void ios.postMessage(shell.weqRemoteBinaryImages ? { url, id } : url).then(accept, abort);
      else {
        shell.addEventListener('weq-remote-qq-image', receive);
        if (android?.loadQqImageBinary && android.supportsBinaryImages?.())
          android.loadQqImageBinary(id, url);
        else android?.loadQqImage?.(id, url);
      }
    } catch {
      abort();
    }
  });
}
