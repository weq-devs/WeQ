/**
 * `file://` → `Response`, without Electron's `net.fetch`.
 *
 * The protocol handlers used `net.fetch(pathToFileURL(p))` to stream a file off
 * disk with `Range` support. Node's global `fetch` refuses `file://`, so the web
 * app needs its own implementation — and since it must behave identically in
 * both shells, Electron uses this one too.
 *
 * Streams via `createReadStream` (never buffers whole files: videos are large
 * and `<video>` seeking issues range requests).
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { Readable } from 'node:stream';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.apng': 'image/apng',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Parse a single `bytes=a-b` range against `size`. Null when absent/unsatisfiable. */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix form `bytes=-N` — the last N bytes.
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Stream `path` as a `Response`, honoring the request's `Range` header.
 * Returns 404 when the file is missing, 206 for a partial response.
 */
export async function fileResponse(path: string, request?: Request): Promise<Response> {
  let size: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return new Response('not a file', { status: 404 });
    size = st.size;
  } catch {
    return new Response('not found', { status: 404 });
  }

  const type = mimeOf(path);
  const range = parseRange(request?.headers.get('range') ?? null, size);

  if (range) {
    const stream = createReadStream(path, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }

  const stream = createReadStream(path);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'Content-Type': type,
      'Content-Length': String(size),
      'Accept-Ranges': 'bytes',
    },
  });
}
