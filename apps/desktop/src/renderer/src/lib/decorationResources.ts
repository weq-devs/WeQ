import { decorationImageCache, DECORATION_DECODE_LIMITS } from './decodedImageCache';
import { fontFaces, type FontLease } from './fontFaces';

export function validDecorationFrames(count: number | undefined): count is number {
  return Number.isSafeInteger(count) && count! > 0 && count! <= DECORATION_DECODE_LIMITS.maxImages;
}

export function prepareDecorationFrames(urls: string[], signal: AbortSignal) {
  const loading = new AbortController();
  const abort = () => loading.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const pin = decorationImageCache.pin(urls.slice(0, DECORATION_DECODE_LIMITS.maxImages));
  const release = () => {
    loading.abort();
    signal.removeEventListener('abort', abort);
    pin.release();
  };
  const ready = (
    !urls.length
      ? Promise.resolve()
      : urls.length > DECORATION_DECODE_LIMITS.maxImages
        ? Promise.reject(new Error('装扮帧数超限'))
        : Promise.all(urls.map((url) => decorationImageCache.require(url, loading.signal)))
  )
    .then(async () => {
      if (urls.length) {
        await nextFrame(loading.signal);
        await nextFrame(loading.signal);
      }
      return !signal.aborted;
    })
    .catch(() => {
      release();
      return false;
    });
  return { ready, release };
}

/** 隐藏文档不预热/播放；静态规则和字体不动，避免恢复时改变消息几何。 */
export function manageDecorationAnimation(urls: string[], activate: () => () => void) {
  const motion =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let controller: AbortController | null = null;
  let frames: ReturnType<typeof prepareDecorationFrames> | null = null;
  let deactivate: (() => void) | null = null;
  let disposed = false;
  let ready = Promise.resolve(true);
  const stop = () => {
    controller?.abort();
    controller = null;
    deactivate?.();
    deactivate = null;
    frames?.release();
    frames = null;
  };
  const update = () => {
    if (disposed) return;
    if (document.visibilityState === 'hidden' || motion?.matches) {
      stop();
      ready = Promise.resolve(true);
      return;
    }
    if (controller) return;
    const current = new AbortController();
    controller = current;
    frames = prepareDecorationFrames(urls, current.signal);
    ready = frames.ready.then((ok) => {
      if (disposed) return false;
      if (current.signal.aborted) return true;
      if (!ok) return false;
      deactivate = activate();
      return true;
    });
  };
  document.addEventListener('visibilitychange', update);
  motion?.addEventListener('change', update);
  update();
  return {
    get ready() {
      return ready;
    },
    release() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener('visibilitychange', update);
      motion?.removeEventListener('change', update);
      stop();
    },
  };
}

type Entry = { users: number; dispose(): void };
const entries = new Map<string, Entry>();
function nextFrame(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cancelAnimationFrame(id);
      reject(new DOMException('装扮已离开视图', 'AbortError'));
    };
    const id = requestAnimationFrame(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** 每款独立样式节点，最后一个使用者释放时一起移除，不反复重解析历史样式。 */
export function acquireDecorationStyle(
  key: string,
  setup: (resource: {
    append(css: string): void;
    font(family: string, url: string): void;
    animate(urls: string[], css: () => string): void;
  }) => void,
): () => void {
  let entry = entries.get(key);
  if (!entry) {
    const node = document.createElement('style');
    node.dataset.weqMsgDecoration = key;
    document.head.appendChild(node);
    const controller = new AbortController();
    const releases: (() => void)[] = [];
    const fonts: FontLease[] = [];
    const created: Entry = {
      users: 0,
      dispose() {
        controller.abort();
        node.remove();
        for (const release of releases) release();
        for (const font of fonts) font.release();
      },
    };
    entries.set(key, created);
    entry = created;
    try {
      setup({
        append(css) {
          if (!controller.signal.aborted) node.appendChild(document.createTextNode(css));
        },
        font(family, url) {
          fonts.push(fontFaces.acquire(family, url));
        },
        animate(urls, css) {
          const frames = manageDecorationAnimation(urls, () => {
            const text = document.createTextNode(css());
            node.appendChild(text);
            return () => text.remove();
          });
          releases.push(frames.release);
        },
      });
    } catch (error) {
      created.dispose();
      entries.delete(key);
      throw error;
    }
  }
  const held = entry;
  held.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--held.users) return;
    // 乐观消息、发送缓存、真实记录可能在同一轮提交中交接，允许新行接走同款资源。
    queueMicrotask(() => {
      if (held.users || entries.get(key) !== held) return;
      held.dispose();
      entries.delete(key);
    });
  };
}
