import { createHash } from 'node:crypto';

const MAX_WINDOW = 1024 * 1024;
const MAX_RETAINED = 16 * MAX_WINDOW;
const MIN_RESUME_PREFIX = 64 * 1024;
const TTL_MS = 15_000;

type Interval = { start: number; end: number };
type ContentRange = Interval & { total: number };
type Segment = {
  key: string;
  range: ContentRange;
  bytes: Uint8Array<ArrayBuffer>;
  headers: Headers;
  tag: string | null;
  expires: number;
  generation: number;
};
type Reuse = { segment: Segment; requested: Interval };

const segments = new Map<string, Segment>();
let retained = 0;
let captures = 0;
let captureGeneration = 0;

export function rangeSourceKey(cachePath: string, url: string, scope?: string): string {
  return createHash('sha256')
    .update(JSON.stringify([scope, cachePath, url]))
    .digest('hex');
}

function parseContentRange(headers: Headers): ContentRange | undefined {
  const raw = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get('content-range') ?? '');
  if (!raw) return;
  const start = Number(raw[1]);
  const end = Number(raw[2]);
  const total = Number(raw[3]);
  if ([start, end, total].every(Number.isSafeInteger) && start <= end && end < total)
    return { start, end, total };
}

function requestedInterval(raw: string, total: number): Interval | undefined {
  const parts = /^bytes=(\d*)-(\d*)$/i.exec(raw.trim());
  if (!parts || (!parts[1] && !parts[2])) return;
  const first = Number(parts[1]);
  const last = Number(parts[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) return;
  const start = parts[1] ? first : Math.max(0, total - last);
  const end = parts[1] && parts[2] ? Math.min(last, total - 1) : total - 1;
  if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end)
    return { start, end };
}

function strongTag(headers: Headers): string | null {
  const value = headers.get('etag');
  return value && /^"[^"\r\n]*"$/.test(value) ? value : null;
}

function remove(id: string, segment: Segment): void {
  segments.delete(id);
  retained -= segment.bytes.byteLength;
}

export function discardVideoRanges(key: string): void {
  for (const [id, segment] of segments) {
    if (segment.key === key) remove(id, segment);
  }
}

export function reusableVideoRange(key: string, headers: Headers): Reuse | undefined {
  const range = headers.get('range');
  if (!range) return;
  const condition = headers.get('if-range');
  const now = Date.now();
  let best: { id: string; hit: Reuse } | undefined;
  for (const [id, segment] of segments) {
    if (segment.expires <= now) {
      remove(id, segment);
      continue;
    }
    if (segment.key !== key || (condition !== null && condition !== segment.tag)) continue;
    const requested = requestedInterval(range, segment.range.total);
    if (!requested || requested.start < segment.range.start || requested.start > segment.range.end)
      continue;
    // 起播有时只探测两个字节。小片段可以直接命中，续接从至少一个读块开始。
    if (
      requested.end > segment.range.end &&
      (!segment.tag || segment.range.end - requested.start + 1 < MIN_RESUME_PREFIX)
    )
      continue;
    if (!best || segment.range.end >= best.hit.segment.range.end)
      best = { id, hit: { segment, requested } };
  }
  if (best) {
    segments.delete(best.id);
    segments.set(best.id, best.hit.segment);
    return best.hit;
  }
}

function rangeResponseHeaders(headers: Headers, range: Interval, total: number): Headers {
  const result = new Headers(headers);
  result.set('Content-Range', `bytes ${range.start}-${range.end}/${total}`);
  result.set('Content-Length', String(range.end - range.start + 1));
  result.set('Accept-Ranges', 'bytes');
  return result;
}

export function cachedVideoRange(
  { segment, requested }: Reuse,
  check: () => void,
): Response | undefined {
  if (requested.end > segment.range.end) return;
  const offset = requested.start - segment.range.start;
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of ['content-type', 'etag', 'last-modified']) {
    const value = segment.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        check();
        stream.enqueue(segment.bytes.slice(offset, offset + requested.end - requested.start + 1));
        stream.close();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: 206,
    headers: rangeResponseHeaders(headers, requested, segment.range.total),
  });
}

export function resumeVideoRangeHeaders(headers: Headers, { segment, requested }: Reuse): Headers {
  const resumed = new Headers(headers);
  resumed.set('Range', `bytes=${segment.range.end + 1}-${requested.end}`);
  resumed.set('If-Range', segment.tag!);
  return resumed;
}

export function resumeVideoRange(
  tail: Response,
  { segment, requested }: Reuse,
): Response | undefined {
  const range = parseContentRange(tail.headers);
  if (
    tail.status !== 206 ||
    !tail.body ||
    range?.start !== segment.range.end + 1 ||
    range.end !== requested.end ||
    range.total !== segment.range.total ||
    strongTag(tail.headers) !== segment.tag ||
    !['', 'identity'].includes(tail.headers.get('content-encoding') ?? '') ||
    Number(tail.headers.get('content-length')) !== range.end - range.start + 1 ||
    tail.headers.get('content-type') !== segment.headers.get('content-type')
  )
    return;
  const bytes = segment.bytes.subarray(requested.start - segment.range.start);
  const reader = tail.body.getReader();
  let first = true;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(stream) {
        if (first) {
          first = false;
          stream.enqueue(bytes);
          return;
        }
        const next = await reader.read();
        if (next.done) stream.close();
        else stream.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: 206,
    headers: rangeResponseHeaders(tail.headers, requested, range.total),
  });
}

function remember(segment: Segment): void {
  const id = `${segment.key}:${segment.range.start}`;
  const now = Date.now();
  if (segment.expires <= now) return;
  const changed = (old: Segment) =>
    old.tag !== segment.tag || old.range.total !== segment.range.total;
  for (const old of segments.values()) {
    if (
      old.key === segment.key &&
      old.expires > now &&
      old.generation > segment.generation &&
      changed(old)
    )
      return;
  }
  for (const [oldId, old] of segments) {
    if (old.key !== segment.key) continue;
    if (changed(old)) remove(oldId, old);
    else if (oldId === id) {
      if (old.range.end >= segment.range.end && old.expires > now) return;
      remove(oldId, old);
    }
  }
  while (segments.size >= 64 || retained + segment.bytes.byteLength > MAX_RETAINED) {
    const oldest = segments.entries().next().value;
    if (!oldest) break;
    remove(...oldest);
  }
  segments.set(id, segment);
  retained += segment.bytes.byteLength;
}

export function captureVideoRange(key: string, requestRange: string, response: Response) {
  const range = parseContentRange(response.headers);
  const requested = range && requestedInterval(requestRange, range.total);
  if (
    captures >= 4 ||
    response.status !== 206 ||
    !range ||
    requested?.start !== range.start ||
    requested.end !== range.end ||
    Number(response.headers.get('content-length')) !== range.end - range.start + 1 ||
    !['', 'identity'].includes(response.headers.get('content-encoding') ?? '') ||
    !/^video\/|^application\/octet-stream$/i.test(response.headers.get('content-type') ?? '')
  )
    return;
  const directives = response.headers.get('cache-control') ?? '';
  if (/\b(?:no-store|no-cache)\b/i.test(directives) || response.headers.get('vary') === '*') return;
  const seconds = /\bmax-age=(\d+)/i.exec(directives);
  const age = Number(response.headers.get('age')) * 1000 || 0;
  const ttl = Math.min(seconds ? Number(seconds[1]) * 1000 - age : TTL_MS, TTL_MS);
  if (ttl <= 0) return;

  const expires = Date.now() + ttl;
  const generation = ++captureGeneration;
  captures++;
  let data: Uint8Array<ArrayBuffer> | undefined;
  let used = 0;
  let closed = false;
  const capture = {
    append(chunk: Uint8Array) {
      if (closed) return;
      data ??= new Uint8Array(Math.min(range.end - range.start + 1, MAX_WINDOW));
      if (used === data.byteLength) return;
      const slice = chunk.subarray(0, data.byteLength - used);
      data.set(slice, used);
      used += slice.byteLength;
    },
    close(keep: boolean) {
      if (closed) return;
      closed = true;
      clearTimeout(expire);
      captures--;
      const buffer = data;
      data = undefined;
      if (!keep || !buffer || !used) return;
      remember({
        key,
        range: { ...range, end: range.start + used - 1 },
        bytes: used === buffer.byteLength ? buffer : buffer.slice(0, used),
        headers: new Headers(response.headers),
        tag: strongTag(response.headers),
        expires,
        generation,
      });
    },
  };
  const expire = setTimeout(() => capture.close(false), 30_000);
  expire.unref?.();
  return capture;
}
