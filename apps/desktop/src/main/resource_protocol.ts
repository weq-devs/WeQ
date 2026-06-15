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
 *   weq-asset://emoji/358/apng/358.png  →  resources/emoji/358/apng/358.png
 * The host segment and path are joined; `..` traversal outside the root is 403.
 *
 * `registerResourceScheme()` MUST run before app `ready`; `registerResource-
 * Protocol()` MUST run after.
 */

import { net, protocol } from 'electron';
import { join, normalize, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveResourceRoot } from './resource';

export const RESOURCE_SCHEME = 'weq-asset';

export function registerResourceScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RESOURCE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export function registerResourceProtocol(): void {
  protocol.handle(RESOURCE_SCHEME, async (request) => {
    const root = resolveResourceRoot();
    if (!root) return new Response('resources root not found', { status: 404 });

    const url = new URL(request.url);
    const relative = decodeURIComponent(`${url.hostname}${url.pathname}`);
    const target = normalize(join(root, relative));

    // Containment check — refuse anything that escapes the resources root.
    if (target !== root && !target.startsWith(root + sep)) {
      return new Response('forbidden', { status: 403 });
    }

    return net.fetch(pathToFileURL(target).toString());
  });
}
