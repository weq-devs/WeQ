/**
 * Static file serving for the built SPA, with an index.html fallback so
 * client-side routes resolve.
 */

import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileResponse, mimeOf } from '../file_response';
import { matchesIfNoneMatch } from '../protocol_response';
import { writeResponse } from './protocol_adapter';
import { preparedStartupDocument } from './startup_assets';
import { acceptsGzip, hashedWebCodePath } from './compression';

export async function serveStatic(
  res: ServerResponse,
  root: string,
  urlPath: string,
  acceptEncoding = '',
  remoteStartup = false,
  ifNoneMatch: string | null = null,
): Promise<void> {
  const clean = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const target = normalize(join(root, clean));

  // Containment — a crafted path must not escape the public dir.
  const inRoot = target === root || target.startsWith(root + sep);
  const found = inRoot ? await stat(target).catch(() => undefined) : undefined;
  const index = join(root, 'index.html');
  const isFile = found?.isFile() ?? false;
  // Anything that isn't a real file falls through to the SPA shell.
  const path = isFile ? target : index;
  if (!isFile && !(await stat(index).catch(() => undefined))?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('build missing — run `pnpm --filter @weq/web build`');
    return;
  }

  const remoteShell = remoteStartup && path === index;
  // 仅压缩静态文本资源，媒体继续沿用原有流式语义。
  const compressible =
    isFile && /\.(?:js|css|svg|json|txt)$/i.test(path) && (found?.size ?? 0) >= 1024;
  const gzip = (compressible || remoteShell) && acceptsGzip(acceptEncoding);
  // 哈希资源为 immutable，HTML 文档需读取当前构建。
  const cache =
    isFile && clean.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store';
  if (remoteShell) {
    const { body, etag } = await preparedStartupDocument(root, await readFile(path, 'utf8'), gzip);
    const unchanged = matchesIfNoneMatch(ifNoneMatch, etag);
    res
      .writeHead(unchanged ? 304 : 200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': cache,
        Vary: 'Accept-Encoding, User-Agent',
        ETag: etag,
      })
      .end(unchanged ? undefined : body);
    return;
  }
  if (gzip && isFile && hashedWebCodePath.test(clean)) {
    const encoded = await fileResponse(`${path}.gz`);
    if (encoded.ok) {
      const headers = new Headers(encoded.headers);
      headers.set('Content-Type', mimeOf(path));
      headers.set('Content-Encoding', 'gzip');
      headers.set('Cache-Control', cache);
      headers.set('Vary', 'Accept-Encoding');
      headers.delete('Accept-Ranges');
      await writeResponse(res, new Response(encoded.body, { status: encoded.status, headers }));
      return;
    }
  }

  const out = await fileResponse(path);
  const headers = new Headers(out.headers);
  headers.set('Cache-Control', cache);
  if (compressible) headers.set('Vary', 'Accept-Encoding');
  if (compressible && out.body && gzip) {
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
