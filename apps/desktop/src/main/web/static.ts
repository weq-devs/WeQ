/**
 * Static file serving for the built SPA, with an index.html fallback so
 * client-side routes resolve.
 */

import { existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileResponse } from '../file_response';
import { writeResponse } from './protocol_adapter';

function acceptsGzip(value: string): boolean {
  const weights = new Map<string, number>();
  for (const part of value.split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    const weight = quality ? Number(quality.slice(2)) : 1;
    weights.set(name ?? '', Number.isFinite(weight) && weight >= 0 && weight <= 1 ? weight : 0);
  }
  return (weights.get('gzip') ?? weights.get('*') ?? 0) > 0;
}

export async function serveStatic(
  res: ServerResponse,
  root: string,
  urlPath: string,
  acceptEncoding = '',
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
  // 仅压缩静态文本资源；媒体和下载继续保持原有 Range / 流式语义。
  const compressible =
    isFile &&
    /\.(?:js|css|svg|json|txt)$/i.test(path) &&
    Number(headers.get('Content-Length')) >= 1024;
  if (compressible) headers.set('Vary', 'Accept-Encoding');
  if (compressible && out.body && acceptsGzip(acceptEncoding)) {
    headers.set('Content-Encoding', 'gzip');
    headers.delete('Content-Length');
    headers.delete('Accept-Ranges');
    res.writeHead(out.status, Object.fromEntries(headers));
    await pipeline(
      Readable.fromWeb(out.body as Parameters<typeof Readable.fromWeb>[0]),
      createGzip(),
      res,
    );
    return;
  }
  await writeResponse(res, new Response(out.body, { status: out.status, headers }));
}
