import { createServer, type Server, type RequestListener } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { requestApiJson, DEFAULT_API_TIMEOUT_MS } from '../src/api_usage';
import type { AgentLabUsage } from '../src/types';
import { TtsService } from '../src/tts';

const servers: Server[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const timer of timers.splice(0)) clearInterval(timer);
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

it('默认期限生效，快速成功后清理期限计时器，预取消不产生请求或账目', async () => {
  vi.useFakeTimers();
  const updates: AgentLabUsage[] = [];
  const endpoint = {
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic',
    model: 'synthetic',
    onUsage: (entry: AgentLabUsage) => updates.push(entry),
  };
  const fetch = vi.fn(
    (_url: unknown, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const outcome = requestApiJson(endpoint, '/embeddings', {}).catch((error: Error) => error.name);
  await vi.advanceTimersByTimeAsync(DEFAULT_API_TIMEOUT_MS);
  expect(await outcome).toBe('TimeoutError');
  expect(vi.getTimerCount()).toBe(0);
  fetch.mockImplementation(async () => new Response('{}'));
  await requestApiJson(endpoint, '/embeddings', {});
  expect(vi.getTimerCount()).toBe(0);
  const calls = fetch.mock.calls.length,
    count = updates.length;
  await expect(
    requestApiJson({ ...endpoint, signal: AbortSignal.abort() }, '/embeddings', {}),
  ).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(updates).toHaveLength(count);
});

async function fixture(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('夹具监听失败');
  const updates: AgentLabUsage[] = [];
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    model: 'synthetic',
    apiKey: 'synthetic',
    timeoutMs: 60,
    onUsage: (entry: AgentLabUsage) => updates.push(entry),
    updates,
  };
}

it.each(['headers', 'body', 'slow-stream'] as const)(
  '期限覆盖 %s 挂起，不重试且记为失败',
  async (mode) => {
    let calls = 0;
    const f = await fixture((_req, res) => {
      calls++;
      if (mode === 'headers') return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":[');
      if (mode === 'slow-stream') timers.push(setInterval(() => res.write(' '), 10));
    });
    const controller = new AbortController();
    const request = requestApiJson(f, '/chat/completions', {
      method: 'POST',
      signal: controller.signal,
    });
    try {
      const outcome = await Promise.race([
        request.then(
          () => 'success',
          (e: Error) => e.name,
        ),
        delay(200).then(() => 'hung'),
      ]);
      expect(outcome).toBe('TimeoutError');
      expect(f.updates.at(-1)?.status).toBe('failed');
      expect(calls).toBe(1);
    } finally {
      controller.abort();
      await request.catch(() => {});
    }
  },
);

it('收到响应头后的调用方取消终止正文读取，记为取消', async () => {
  const controller = new AbortController();
  const cleanup = new AbortController();
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    setImmediate(() => controller.abort());
  });
  const request = requestApiJson({ ...f, signal: controller.signal }, '/chat/completions', {
    signal: cleanup.signal,
  });
  try {
    expect(
      await Promise.race([
        request.then(
          () => 'success',
          (e: Error) => e.name,
        ),
        delay(200).then(() => 'hung'),
      ]),
    ).toBe('AbortError');
    expect(f.updates.at(-1)?.status).toBe('cancelled');
  } finally {
    cleanup.abort();
    await request.catch(() => {});
  }
});

it('正常请求保持返回值与用量；非法期限在联网前拒绝', async () => {
  let calls = 0;
  const f = await fixture((_req, res) => {
    calls++;
    res.end('{"ok":true,"usage":{"total_tokens":3}}');
  });
  await expect(requestApiJson(f, '/embeddings', {})).resolves.toMatchObject({ ok: true });
  expect(f.updates.at(-1)).toMatchObject({ status: 'success', totalTokens: 3 });
  await expect(requestApiJson({ ...f, timeoutMs: -1 }, '/embeddings', {})).rejects.toThrow();
  expect(calls).toBe(1);
});

it('语音正文挂起时，实例取消也会关闭请求并记录取消终态', async () => {
  const controller = new AbortController();
  const f = await fixture((_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.write(new Uint8Array(101).fill(1));
    setImmediate(() => controller.abort());
  });
  const tts = new TtsService(f.onUsage);
  await expect(
    tts.synthesize(
      {
        id: 'synthetic',
        name: 'synthetic',
        vendor: 'openai-compatible',
        baseUrl: f.baseUrl,
        apiKey: 'synthetic',
        createdAt: 0,
        updatedAt: 0,
      },
      '合成文本',
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(f.updates.at(-1)?.status).toBe('cancelled');
});
