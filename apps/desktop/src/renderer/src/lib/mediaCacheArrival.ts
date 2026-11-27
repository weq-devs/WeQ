import { chatStickerMd5 } from '../../../shared/chat_sticker';

const byDocument = new WeakMap<Document, EventTarget>();

function identity(source: string) {
  let url: URL;
  try {
    url = new URL(source, location.href);
  } catch {
    return null;
  }
  const kind =
    url.protocol === 'weq-media:' ? url.hostname : /^\/_media\/(\w+)$/.exec(url.pathname)?.[1];
  const query = url.searchParams;
  const scope = query.get('cacheScope') ?? query.get('weqCacheScope');
  if (kind === 'album' || kind === 'dress') {
    const src = query.get('src');
    return src ? JSON.stringify([kind, src]) : null;
  }
  if (kind === 'mface') {
    const pack = query.get('pack');
    const hash = query.get('hash');
    return pack && hash ? JSON.stringify(['mface', scope, pack, hash]) : null;
  }
  if (kind !== 'pic') return null;
  const token = query.get('token');
  const md5 = query.get('md5');
  const name = query.get('name');
  if (query.get('recv') === '1') {
    const hash = chatStickerMd5(md5, name);
    if (hash || token)
      return JSON.stringify(['emoji', scope, hash ? 'md5' : 'token', hash ?? token]);
  }
  return token || md5 || name
    ? JSON.stringify(['pic', token, md5, name, query.get('t'), query.get('recv')])
    : null;
}

/** 仅唤醒同一窗口中这张图的缺图占位，仍由原位请求检查缓存和流量策略。 */
export function watchMediaCache(owner: Document, source: string, listener: () => void) {
  const key = identity(source);
  if (!key) return;
  let events = byDocument.get(owner);
  if (!events) {
    events = new EventTarget();
    byDocument.set(owner, events);
  }
  events.addEventListener(key, listener);
  return () => events.removeEventListener(key, listener);
}

export function notifyMediaCached(owner: Document, source: string) {
  const key = identity(source);
  if (key) byDocument.get(owner)?.dispatchEvent(new Event(key));
}
