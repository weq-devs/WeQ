import { afterEach, describe, expect, it, vi } from 'vitest';
import { webRequestText } from '../src/account/web/http';

afterEach(() => vi.unstubAllGlobals());

describe('web request bounds', () => {
  it('forwards cancellation to fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    const controller = new AbortController();
    const pending = webRequestText('https://fixture.invalid', {
      cookie: '',
      signal: controller.signal,
    });
    controller.abort(new Error('cancelled by test'));
    await expect(pending).rejects.toThrow('cancelled by test');
  });

  it('times out a request that never responds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      ),
    );
    await expect(
      webRequestText('https://fixture.invalid', { cookie: '', timeoutMs: 5 }),
    ).rejects.toThrow('请求超时');
  });

  it('rejects an oversized streamed response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('123456', { headers: { 'content-type': 'text/plain' } })),
    );
    await expect(
      webRequestText('https://fixture.invalid', { cookie: '', maxResponseBytes: 5 }),
    ).rejects.toThrow('响应超过');
  });
});
