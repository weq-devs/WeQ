import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { handleMediaRequest } from './media_protocol';

/** 导出复用真实预览媒体链，包括本地查找、在线下载及外部 rkey 回退。 */
export async function compositionMediaSource(
  segment: Record<string, unknown>,
  node: { time: number; sourceMsgId?: string },
  directory: string,
  signal: AbortSignal,
  check: () => void,
): Promise<string | null> {
  const raw = segment.t === 'opaque' ? segment.element : segment.preview;
  if (!raw || typeof raw !== 'object') return null;
  const element = raw as { type?: string; data?: Record<string, unknown> };
  if (!element.data || !['pic', 'video', 'ptt', 'file'].includes(element.type ?? '')) return null;
  const data = element.data;
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const name = text(data.fileName) || text(segment.fileName);
  if (!name && !text(data.fileToken) && !text(data.md5)) return null;
  const params = new URLSearchParams({
    t: String(node.time * 1000),
    name,
    token: text(data.fileToken),
    msgId: text(data.mediaMsgId) || node.sourceMsgId || '',
    lookup: '2',
  });
  if (text(data.originalUrl)) params.set('orig', text(data.originalUrl));
  if (text(data.md5)) params.set('md5', text(data.md5));
  if (Number(data.subType) === 1 && element.type === 'pic') params.set('recv', '1');
  check();
  signal.throwIfAborted();
  const response = await handleMediaRequest(
    new Request(`weq-media://${element.type}?${params}`, { signal }),
    check,
  );
  try {
    check();
    signal.throwIfAborted();
    if (!response.ok || !response.body) return null;
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    const imageSuffix: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/avif': '.avif',
    };
    const suffix =
      element.type === 'ptt'
        ? '.wav'
        : ((element.type === 'pic' ? imageSuffix[contentType] : undefined) ??
          extname(name).match(/^\.[\da-z]{1,12}$/i)?.[0] ??
          (element.type === 'pic' ? '.jpg' : element.type === 'video' ? '.mp4' : '.bin'));
    const path = join(directory, `${randomUUID()}${suffix}`);
    await mkdir(directory, { recursive: true });
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      createWriteStream(path, { flags: 'wx' }),
      { signal },
    );
    check();
    signal.throwIfAborted();
    return path;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
