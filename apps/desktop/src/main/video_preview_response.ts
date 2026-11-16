import { randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bounded, networkFetch } from '@weq/network';
import { mediaSignature } from '@weq/service';
import { ManagedDownload } from '@weq/service/managed-download';
import { scopedNetworkAllowed } from '@weq/service/network-scope';

/** 原片边读边播；仅完整响应可以原子发布为缓存，取消或分段读取不留下半片。 */
export async function videoPreviewResponse(
  url: string,
  cachePath: string,
  request: Request,
  check: () => void = () => {},
): Promise<Response> {
  if (!scopedNetworkAllowed()) return new Response('省流量模式：点击加载', { status: 409 });
  check();
  const controller = new AbortController();
  const abort = () => controller.abort(request.signal.reason);
  request.signal.addEventListener('abort', abort, { once: true });
  if (request.signal.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armTimeout = (ms: number) => {
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new DOMException('视频连接或读取超时', 'TimeoutError')),
      ms,
    );
    timer.unref?.();
  };
  const release = () => {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
  };
  const headers = new Headers({ 'Accept-Encoding': 'identity' });
  for (const name of ['range', 'if-range']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let upstream: Response;
  try {
    controller.signal.throwIfAborted();
    armTimeout(15_000);
    upstream = await bounded(
      networkFetch(url, { headers, signal: controller.signal }),
      controller.signal,
    );
    clearTimeout(timer);
    try {
      check();
    } catch (error) {
      await upstream.body?.cancel(error);
      throw error;
    }
  } catch (error) {
    controller.abort(error);
    release();
    throw error;
  }
  const responseHeaders = new Headers({ 'Cache-Control': 'no-store' });
  for (const name of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  const type = (upstream.headers.get('content-type') ?? '').toLowerCase();
  if (![200, 206].includes(upstream.status) || !upstream.body || /^(text\/)|json|xml/.test(type)) {
    try {
      await upstream.body?.cancel();
    } finally {
      release();
    }
    responseHeaders.delete('Content-Length');
    return upstream.status === 416
      ? new Response(null, { status: 416, headers: responseHeaders })
      : new Response('视频来源不可用', { status: 502 });
  }
  if (!type) responseHeaders.set('Content-Type', 'video/mp4');

  // 206 也可能覆盖整片（bytes=0-）；只有范围、长度均一致时才写完整缓存。
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upstream.headers.get('content-range') ?? '');
  const length = Number(upstream.headers.get('content-length'));
  const full =
    upstream.status === 200
      ? !upstream.headers.has('content-range')
      : Boolean(range && Number(range[1]) === 0 && Number(range[2]) + 1 === Number(range[3]));
  const encoded = !['', 'identity'].includes(upstream.headers.get('content-encoding') ?? '');
  if (encoded) responseHeaders.delete('Content-Length');
  let cacheable =
    !encoded &&
    full &&
    Number.isSafeInteger(length) &&
    length > 0 &&
    (!range || Number(range[3]) === length);
  const temporary = `${cachePath}.${randomUUID()}.preview.part`;
  const reader = upstream.body.getReader();
  let file: FileHandle | undefined;
  let received = 0;
  let prefix = Buffer.alloc(0);
  let writing: Promise<void> = Promise.resolve();
  const discard = async () => {
    const opened = file;
    file = undefined;
    await opened?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  };
  const cache = async (chunk: Uint8Array) => {
    if (!cacheable) return;
    try {
      if (!file) {
        await mkdir(dirname(cachePath), { recursive: true });
        file = await open(temporary, 'wx');
      }
      await file.writeFile(chunk);
    } catch {
      // 缓存不可写不影响播放；不覆盖现有缓存，也不在别处生成替代文件。
      cacheable = false;
      await discard();
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(stream) {
        writing = (async () => {
          try {
            check();
            controller.signal.throwIfAborted();
            armTimeout(30_000);
            const chunk = await bounded(reader.read(), controller.signal);
            clearTimeout(timer);
            check();
            controller.signal.throwIfAborted();
            if (chunk.done) {
              if (
                !encoded &&
                ((length > 0 && received !== length) || (full && !mediaSignature(prefix, 'video')))
              )
                throw new Error('视频内容不完整或格式不符');
              if (cacheable && file) {
                await file.close();
                file = undefined;
                check();
                controller.signal.throwIfAborted();
                await link(temporary, cachePath).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== 'EEXIST') cacheable = false;
                });
              }
              await discard();
              release();
              stream.close();
              return;
            }
            received += chunk.value.byteLength;
            if (prefix.length < 32)
              prefix = Buffer.concat([prefix, chunk.value.subarray(0, 32 - prefix.length)]);
            await cache(chunk.value);
            controller.signal.throwIfAborted();
            stream.enqueue(chunk.value);
          } catch (error) {
            controller.abort(error);
            await reader.cancel(error).catch(() => {});
            await discard();
            release();
            stream.error(error);
          }
        })();
        return writing;
      },
      async cancel(reason) {
        controller.abort(reason);
        await reader.cancel(reason).catch(() => {});
        await writing;
        await discard();
        release();
      },
    },
    { highWaterMark: 0 },
  );
  return new ManagedDownload().response(
    new Response(body, { status: upstream.status, headers: responseHeaders }),
  );
}
