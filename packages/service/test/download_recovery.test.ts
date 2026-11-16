import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ManagedDownload } from '../src/common/managed_download';

const roots: string[] = [];
async function target() {
  const root = await mkdtemp(join(tmpdir(), 'weq-download-recovery-'));
  roots.push(root);
  return join(root, 'file');
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('持续有进展的正文不受首字节期限截断', async () => {
  const path = await target();
  const fetcher = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            let count = 0;
            const timer = setInterval(() => {
              controller.enqueue(new Uint8Array([++count]));
              if (count === 8) {
                clearInterval(timer);
                controller.close();
              }
            }, 10);
            init?.signal?.addEventListener(
              'abort',
              () => {
                clearInterval(timer);
                controller.error(init.signal?.reason);
              },
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Length': '8' } },
      ),
  );
  await new ManagedDownload({ fetcher, timeoutMs: 30, idleTimeoutMs: 30, maxAttempts: 1 }).file(
    'https://fixture.invalid/file',
    path,
  );
  expect((await readFile(path)).length).toBe(8);
});

it('连接错误自动重试，不要求用户重新点击', async () => {
  const path = await target();
  const fetcher = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(new Response('data'));
  await new ManagedDownload({ fetcher, retryBaseMs: 0 }).file('https://fixture.invalid/file', path);
  expect(await readFile(path, 'utf8')).toBe('data');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('正文断流后保留分段，下一次请求从正确偏移恢复', async () => {
  const path = await target();
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (fetcher.mock.calls.length === 1)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('ab'));
            setTimeout(() => controller.error(new TypeError('socket closed')), 10);
          },
        }),
        { headers: { 'Content-Length': '4', ETag: '"v1"' } },
      );
    expect(new Headers(init?.headers).get('range')).toBe('bytes=2-');
    return new Response('cd', {
      status: 206,
      headers: {
        'Content-Range': 'bytes 2-3/4',
        'Content-Length': '2',
        ETag: '"v1"',
      },
    });
  });
  await new ManagedDownload({ fetcher, retryBaseMs: 0 }).file('https://fixture.invalid/file', path);
  expect(await readFile(path, 'utf8')).toBe('abcd');
});

it('可信内容身份允许跨源 Range 续传，不发送旧源 If-Range', async () => {
  const path = await target();
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).includes('first'))
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('ab'));
            setTimeout(() => controller.error(new TypeError('socket closed')), 10);
          },
        }),
        { headers: { 'Content-Length': '4', ETag: '"first"' } },
      );
    expect(new Headers(init?.headers).get('range')).toBe('bytes=2-');
    expect(new Headers(init?.headers).has('if-range')).toBe(false);
    return new Response('cd', {
      status: 206,
      headers: {
        'Content-Range': 'bytes 2-3/4',
        'Content-Length': '2',
        ETag: '"second"',
      },
    });
  });
  await new ManagedDownload({
    fetcher,
    retryBaseMs: 0,
    attemptsPerSource: 1,
    identity: { sha256: createHash('sha256').update('abcd').digest('hex'), size: 4 },
  }).file(['https://first.invalid/file', 'https://second.invalid/file'], path);
  expect(await readFile(path, 'utf8')).toBe('abcd');
});

it('用户取消不重试，永久 HTTP 错误不在同源重试', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
  await expect(
    new ManagedDownload({ fetcher, retryBaseMs: 0 }).file(
      'https://fixture.invalid/file',
      await target(),
    ),
  ).rejects.toThrow('404');
  expect(fetcher).toHaveBeenCalledOnce();
});

it('完整且哈希正确的遗留分段直接完成，不请求越界 Range', async () => {
  const path = await target();
  const sha256 = createHash('sha256').update('data').digest('hex');
  await writeFile(`${path}.part`, 'data');
  await writeFile(
    `${path}.resume.json`,
    JSON.stringify({ url: 'https://fixture.invalid/file', validator: '"v1"', total: 4, sha256 }),
  );
  const fetcher = vi.fn<typeof fetch>(async () => new Response('', { status: 416 }));
  await new ManagedDownload({ fetcher, identity: { size: 4, sha256 } }).file(
    'https://fixture.invalid/file',
    path,
  );
  expect(await readFile(path, 'utf8')).toBe('data');
  expect(fetcher).not.toHaveBeenCalled();
});

it('无响应首字节和停滞正文都能结束，包括不配合取消的传输', async () => {
  for (const fetcher of [
    vi.fn<typeof fetch>(() => new Promise(() => {})),
    vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start() {} }))),
  ]) {
    await expect(
      new ManagedDownload({ fetcher, timeoutMs: 10, idleTimeoutMs: 10, maxAttempts: 1 }).file(
        'https://fixture.invalid/file',
        await target(),
      ),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
  }
});

it('429 服从 Retry-After，等待期间用户取消会立即结束且不重试', async () => {
  const controller = new AbortController();
  const path = await target();
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }),
  );
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = new ManagedDownload({
    fetcher,
    signal: controller.signal,
    state: (state) => {
      if (state.retryAt) {
        expect(state.retryAt - Date.now()).toBeGreaterThan(59000);
        release();
      }
    },
  }).file('https://fixture.invalid/file', path);
  const rejected = expect(work).rejects.toThrow('cancelled');
  await waiting;
  controller.abort(new Error('cancelled'));
  await rejected;
  expect(fetcher).toHaveBeenCalledOnce();
});

it('服务器忽略 Range 时重写分段，不追加重复内容', async () => {
  const path = await target();
  const sha256 = createHash('sha256').update('data').digest('hex');
  await writeFile(`${path}.part`, 'da');
  await writeFile(
    `${path}.resume.json`,
    JSON.stringify({ url: 'https://fixture.invalid/file', validator: '"v1"', total: 4, sha256 }),
  );
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response('data', { headers: { 'Content-Length': '4' } }),
  );
  await new ManagedDownload({ fetcher, identity: { size: 4, sha256 } }).file(
    'https://fixture.invalid/file',
    path,
  );
  expect(await readFile(path, 'utf8')).toBe('data');
});

it('坏哈希来源不能发布文件；清除坏分段再换源重下', async () => {
  const path = await target();
  const sha256 = createHash('sha256').update('data').digest('hex');
  const fetcher = vi.fn<typeof fetch>(
    async (url) =>
      new Response(String(url).includes('first') ? 'evil' : 'data', {
        headers: { 'Content-Length': '4' },
      }),
  );
  await new ManagedDownload({ fetcher, retryBaseMs: 0, identity: { size: 4, sha256 } }).file(
    ['https://first.invalid/file', 'https://second.invalid/file'],
    path,
  );
  expect(await readFile(path, 'utf8')).toBe('data');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(new Headers(fetcher.mock.calls[1]![1]?.headers).has('range')).toBe(false);
});
