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
import { open, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Readable } from 'node:stream';
import { sniffImageExt } from '@weq/service';
import { matchesIfNoneMatch } from './protocol_response';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.apng': 'image/apng',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
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

export async function fileContentType(
  path: string,
  opts: { sniffImageType?: boolean; sniffMediaType?: boolean } = {},
): Promise<string> {
  const fallback = mimeOf(path);
  const sniffMedia = opts.sniffMediaType || /^[a-f0-9]{64}$/.test(basename(path));
  if (!sniffMedia && !(opts.sniffImageType && fallback === 'application/octet-stream'))
    return fallback;

  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead);
    const image = sniffImageExt(head);
    if (image) return mimeOf(`image${image}`);
    if (!sniffMedia) return fallback;

    if (head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WAVE')
      return 'audio/wav';
    if (head.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
    if (bytesRead >= 12 && head.toString('ascii', 4, 8) === 'ftyp') {
      const brand = head.toString('ascii', 8, 12);
      if (brand === 'qt  ') return 'video/quicktime';
      if (brand === 'avif' || brand === 'avis') return 'image/avif';
      if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
      if (brand === 'mif1' || brand === 'msf1') return 'image/heif';
      if (brand.startsWith('M4A')) return 'audio/mp4';
      if (/^(isom|iso[2-9]|mp4[12]|avc1|dash|M4V )$/.test(brand)) return 'video/mp4';
    }
    if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
      return 'video/webm';
    if (
      head.toString('ascii', 0, 3) === 'ID3' ||
      (bytesRead >= 4 &&
        head[0] === 0xff &&
        (head[1]! & 0xe6) === 0xe2 &&
        (head[1]! & 0x18) !== 0x08 &&
        (head[2]! & 0xf0) !== 0xf0 &&
        (head[2]! & 0x0c) !== 0x0c)
    )
      return 'audio/mpeg';
    return fallback;
  } finally {
    await handle.close();
  }
}

export function mediaDownloadName(path: string, type: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Keep archive filenames usable on every host.
  const name = basename(path).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  if (!/^(image|audio|video)\//.test(type) || mimeOf(name) === type) return name;
  const extension = Object.entries(MIME).find(([, value]) => value === type)?.[0];
  const old = extname(name);
  return extension ? `${old ? name.slice(0, -old.length) : name}${extension}` : name;
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
 *
 * `revalidate` opts the file into ETag + `Last-Modified` + `Cache-Control: no-cache`,
 * so Chromium re-asks with `If-Modified-Since` and we answer 304 when the file
 * hasn't changed. Use it for paths whose NAME is stable but whose CONTENT is
 * rewritten in place — QQ's `nt_data/avatar` files are keyed by a uid hash, so
 * changing your avatar overwrites the same path and a plain `max-age` would
 * pin the old picture in the renderer's cache until it expired.
 */
export async function fileResponse(
  path: string,
  request?: Request,
  opts: { revalidate?: boolean; sniffImageType?: boolean; sniffMediaType?: boolean } = {},
): Promise<Response> {
  let size: number;
  let mtimeMs: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return new Response('not a file', { status: 404 });
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return new Response('not found', { status: 404 });
  }

  const type = await fileContentType(path, opts);
  const range = parseRange(request?.headers.get('range') ?? null, size);

  // `Last-Modified` has one-second granularity, so compare at that resolution —
  // otherwise a sub-second mtime always reads as "newer" and we never 304.
  const lastModified = new Date(Math.floor(mtimeMs / 1000) * 1000);
  const revalidateHeaders = opts.revalidate
    ? {
        'Last-Modified': lastModified.toUTCString(),
        'Cache-Control': 'no-cache',
        ETag: `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`,
      }
    : undefined;

  if (revalidateHeaders && !range) {
    const tag = request?.headers.get('if-none-match') ?? null;
    const since = Date.parse(request?.headers.get('if-modified-since') ?? '');
    // ETag 保留亚秒精度；存在时不能再用秒级时间误判同秒内的新头像。
    if (
      tag !== null
        ? matchesIfNoneMatch(tag, revalidateHeaders.ETag)
        : Number.isFinite(since) && lastModified.getTime() <= since
    ) {
      return new Response(null, { status: 304, headers: revalidateHeaders });
    }
  }

  if (range) {
    const stream = createReadStream(path, { start: range.start, end: range.end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Accept-Ranges': 'bytes',
        ...revalidateHeaders,
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
      ...revalidateHeaders,
    },
  });
}
