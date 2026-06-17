/**
 * `weq-asset://` — read-only bridge that lets the renderer reference files in
 * the shared `resources/` tree without bundling them into the renderer build.
 *
 * Why a protocol (not the `@resources` Vite alias): static imports get inlined
 * into the JS bundle, which would defeat the whole point of shipping the ~40MB
 * emoji set via electron-builder `extraResources`. A protocol streams the file
 * straight off disk at runtime, in both dev and packaged builds.
 *
 * URL shape (standard scheme → authority + path):
 *   weq-asset://brand/logo.png          →  resources/brand/logo.png
 *   weq-asset://emoji/358/apng/358.png  →  <QQ EmojiSystermResource>/358/apng/358.png
 * Non-emoji hosts join host+path onto the bundled resources root. The `emoji`
 * host is special-cased: it streams from the logged-in account's QQ NT emoji
 * directory (the emoji set is no longer bundled — see resolveEmojiRoot). In all
 * cases `..` traversal outside the resolved root is 403.
 *
 * `registerResourceScheme()` MUST run before app `ready`; `registerResource-
 * Protocol()` MUST run after.
 */

import { net, protocol } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveResourceRoot } from './resource';
import { getAppContext } from './context/app_context';

export const RESOURCE_SCHEME = 'weq-asset';

/**
 * Privileged-scheme descriptor for `weq-asset://`. Registered together with
 * every other custom scheme in a single `registerSchemesAsPrivileged` call
 * (Electron only honors one such call before `ready`).
 */
export const RESOURCE_PRIVILEGED_SCHEME = {
  scheme: RESOURCE_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
} as const;

/**
 * Root for `weq-asset://emoji/...` requests: the active account's QQ NT emoji
 * directory. Returns null when no account is open or the directory is missing —
 * the caller then 404s and the renderer falls back to its text placeholder.
 * (Faces only render inside an open session, so a logged-in uin is the norm.)
 */
function resolveEmojiRoot(): string | null {
  const ctx = getAppContext();
  const uin = ctx.account?.context.uin;
  if (uin && ctx.platform) {
    const dir = ctx.platform.emojiResourceDir(uin);
    if (dir) return dir;
  }
  return null;
}

export function registerResourceProtocol(): void {
  protocol.handle(RESOURCE_SCHEME, async (request) => {
    const url = new URL(request.url);
    const isEmoji = url.hostname === 'emoji';

    const root = isEmoji ? resolveEmojiRoot() : resolveResourceRoot();
    if (!root) return new Response('resource root not found', { status: 404 });

    // Emoji lives under its own root, so drop the `emoji` host segment; other
    // hosts are a path segment under the bundled resources root.
    const relative = isEmoji
      ? decodeURIComponent(url.pathname)
      : decodeURIComponent(`${url.hostname}${url.pathname}`);
    const target = normalize(join(root, relative));

    // Containment check — refuse anything that escapes the resources root.
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(target).toString());
  });
}
