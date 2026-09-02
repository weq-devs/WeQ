/**
 * Static file serving for the built SPA, with an index.html fallback so
 * client-side routes resolve.
 */

import { existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';
import { fileResponse } from '@weq/desktop/main/file_response';
import { writeResponse } from './protocol_adapter';

export async function serveStatic(
  res: ServerResponse,
  root: string,
  urlPath: string,
): Promise<void> {
  const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const target = normalize(join(root, clean));

  // Containment — a crafted path must not escape the public dir.
  const inRoot = target === root || target.startsWith(root + sep);
  const isFile = inRoot && existsSync(target) && statSync(target).isFile();

  // Anything that isn't a real file falls through to the SPA shell.
  const path = isFile ? target : join(root, 'index.html');
  if (!existsSync(path)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('build missing — run `pnpm --filter @weq/web build`');
    return;
  }

  const out = await fileResponse(path);
  // Hashed asset filenames are immutable; the shell must never be cached.
  const cache =
    isFile && clean.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
  const headers = new Headers(out.headers);
  headers.set('Cache-Control', cache);
  await writeResponse(res, new Response(out.body, { status: out.status, headers }));
}
