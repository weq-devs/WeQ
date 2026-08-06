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
 * directory (the emoji set is no longer bundled — see resolveEmojiRoots). When
 * that directory is missing or lacks the face, we fall back to our own download
 * cache and — on a miss — fetch the face from the official CDN on demand (see
 * SysEmojiDownloadService). In all cases `..` traversal outside the resolved
 * root is 403.
 *
 * `registerResourceScheme()` MUST run before app `ready`; `registerResource-
 * Protocol()` MUST run after.
 */

import { join, normalize, sep } from 'node:path';
import { resolveResourceRoot } from './resource';
import { fileResponse } from './file_response';
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
 * Roots for `weq-asset://emoji/...`, in lookup order: QQ NT's own emoji
 * directory first, then our download cache (populated when QQ's copy is
 * missing). Either may be absent — an empty list means the face can't be served
 * and the renderer falls back to its placeholder glyph.
 */
function resolveEmojiRoots(): string[] {
  const ctx = getAppContext();
  const roots: string[] = [];
  const uin = ctx.account?.context.uin;
  // `resourcePlatform`, not `platform`: a static account must not resolve emoji
  // out of the local install's directory for the same uin.
  if (uin && ctx.resourcePlatform) {
    const dir = ctx.resourcePlatform.emojiResourceDir(uin);
    if (dir) roots.push(dir);
  }
  const cache = ctx.services?.sysEmojiDownload.root();
  if (cache) roots.push(cache);
  return roots;
}

/** The face id is the first path segment: `/358/apng/358.png` → `358`. */
function faceIdOf(pathname: string): string | null {
  const first = pathname.replace(/^\/+/, '').split('/')[0];
  return first ? decodeURIComponent(first) : null;
}

/** Resolve `relative` against `root`, or null when it escapes the root. */
function containedPath(root: string, relative: string): string | null {
  const target = normalize(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/**
 * Serve one `weq-asset://` request. Pure `Request`→`Response`, so the web app
 * can mount it on a plain HTTP route (see `apps/web`) without Electron.
 */
export async function handleResourceRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname === 'emoji') return handleEmojiRequest(request, url);

  const root = resolveResourceRoot();
  if (!root) return new Response('resource root not found', { status: 404 });

  // Non-emoji hosts are a path segment under the bundled resources root.
  const relative = decodeURIComponent(`${url.hostname}${url.pathname}`);
  const target = containedPath(root, relative);
  if (!target) return new Response('forbidden', { status: 403 });

  return fileResponse(target, request);
}

/**
 * Serve a built-in face. Tries QQ's own resource dir, then our download cache,
 * and on a miss asks the download service to fetch the face's CDN bundle before
 * looking one last time. That on-demand fetch is what makes faces render at all
 * on installs where QQ's emoji directory is absent.
 */
async function handleEmojiRequest(request: Request, url: URL): Promise<Response> {
  const roots = resolveEmojiRoots();
  if (roots.length === 0) return new Response('resource root not found', { status: 404 });

  const relative = decodeURIComponent(url.pathname);
  for (const root of roots) {
    const target = containedPath(root, relative);
    if (!target) return new Response('forbidden', { status: 403 });
    const res = await fileResponse(target, request);
    if (res.status !== 404) return res;
  }

  const faceId = faceIdOf(url.pathname);
  const download = getAppContext().services?.sysEmojiDownload;
  if (!faceId || !download) return new Response('not found', { status: 404 });

  // Only a fresh download can turn a miss into a hit; every other outcome means
  // the file genuinely isn't available (unicode face, bad id, network failure).
  if ((await download.ensure(faceId)) !== 'downloaded') {
    return new Response('not found', { status: 404 });
  }

  const cachePath = containedPath(download.root(), relative);
  return cachePath ? fileResponse(cachePath, request) : new Response('not found', { status: 404 });
}
