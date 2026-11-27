/**
 * Electron custom-scheme registration for the three media/asset protocols.
 *
 * The handlers themselves live next to their logic (`media_protocol.ts`,
 * `avatar_protocol.ts`, `resource_protocol.ts`) as plain `Request → Response`
 * functions with no Electron imports, so the web app can mount them on HTTP
 * routes. This file is the desktop-only shim that binds them to custom schemes.
 */

import { accountIpc } from './window_account_runtime';
import type { Session, WebContents } from 'electron';
import type { AccountRuntime } from './context/account_runtime';
import { MEDIA_SCHEME, handleMediaRequest } from './media_protocol';
import { AVATAR_SCHEME, handleAvatarRequest } from './avatar_protocol';
import { RESOURCE_SCHEME, handleResourceRequest } from './resource_protocol';

export function registerAccountProtocols(session: Session, runtime: AccountRuntime): () => void {
  session.protocol.handle(MEDIA_SCHEME, runtime.bind(handleMediaRequest));
  session.protocol.handle(AVATAR_SCHEME, runtime.bind(handleAvatarRequest));
  session.protocol.handle(RESOURCE_SCHEME, runtime.bind(handleResourceRequest));
  return () => {
    session.protocol.unhandle(MEDIA_SCHEME);
    session.protocol.unhandle(AVATAR_SCHEME);
    session.protocol.unhandle(RESOURCE_SCHEME);
  };
}

export function registerMediaThumbnailIpc(): void {
  // Electron 的 protocol.handle 不会把 Chromium 断连传到 Request.signal。
  const thumbnails = new WeakMap<WebContents, Map<string, AbortController>>();
  accountIpc.handle('media:thumbnail', async ({ sender }, id: string, url: string) => {
    if (typeof id !== 'string' || typeof url !== 'string') return null;
    const parsed = URL.parse(url);
    if (
      parsed?.protocol !== 'weq-media:' ||
      parsed.hostname !== 'pic' ||
      parsed.searchParams.get('v') !== 'thumb' ||
      parsed.searchParams.get('recv') === '1'
    )
      return null;
    let active = thumbnails.get(sender);
    if (!active) {
      const tasks = new Map<string, AbortController>();
      thumbnails.set(sender, tasks);
      sender.once('destroyed', () => {
        for (const controller of tasks.values()) controller.abort();
      });
      active = tasks;
    }
    if (active.has(id)) return null;
    const controller = new AbortController();
    active.set(id, controller);
    try {
      const response = await handleMediaRequest(new Request(parsed, { signal: controller.signal }));
      if (!response.ok || controller.signal.aborted) {
        await response.body?.cancel();
        return response.headers.get('X-WeQ-Media-State') === 'deferred' ? 'deferred' : null;
      }
      return { bytes: await response.arrayBuffer(), type: response.headers.get('Content-Type') };
    } finally {
      active.delete(id);
    }
  });
  accountIpc.on('media:cancel-thumbnail', ({ sender }, id: string) => {
    thumbnails.get(sender)?.get(id)?.abort();
  });
}
