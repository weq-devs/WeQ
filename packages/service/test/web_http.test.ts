import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebRequestError, webRequestJson, webRequestText } from '../src/account/web/http';

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
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
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

  it('retries a transient network failure within the explicit budget', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('socket closed'))
      .mockResolvedValueOnce(new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      webRequestText('https://fixture.invalid/read?token=secret', {
        cookie: '',
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).resolves.toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('classifies rate limits and exposes Retry-After without leaking query values', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('busy', { status: 429, headers: { 'Retry-After': '2' } })),
    );
    const error = await webRequestText('https://fixture.invalid/read?token=secret', {
      cookie: '',
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WebRequestError);
    expect(error).toMatchObject({ kind: 'rate-limit', status: 429, retryAfterMs: 2000 });
    expect(error.message).toContain('2 秒后重试');
    expect(error.message).not.toContain('secret');
  });

  it('does not retry before a Retry-After value outside the local wait budget', async () => {
    const fetchMock = vi.fn(
      async () => new Response('busy', { status: 429, headers: { 'Retry-After': '60' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      webRequestText('https://fixture.invalid/read', {
        cookie: '',
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 100 },
      }),
    ).rejects.toMatchObject({ kind: 'rate-limit', retryAfterMs: 60_000 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('does not replay requests unless the caller supplies a retry budget', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      webRequestText('https://fixture.invalid/write', {
        method: 'POST',
        cookie: '',
        body: 'value=1',
      }),
    ).rejects.toMatchObject({ kind: 'http', status: 503 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('stops an in-progress retry budget when cancelled', async () => {
    const fetchMock = vi.fn(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const pending = webRequestText('https://fixture.invalid/read', {
      cookie: '',
      signal: controller.signal,
      retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 1000 },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifies malformed JSON without including the response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('private response body')),
    );
    const error = await webRequestJson('https://fixture.invalid/json', { cookie: '' }).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ kind: 'decode' });
    expect(error.message).not.toContain('private response body');
  });
});
