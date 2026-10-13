import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WebRequestError,
  webRequestBytes,
  webRequestJson,
  webRequestText,
} from '../src/account/web/http';

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

describe('uncooperative transports and total retry budgets', () => {
  it('returns on timeout and cancels a response which arrives after the caller has left', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    await expect(
      webRequestBytes('https://fixture.invalid/read', { cookie: '', timeoutMs: 5 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    const cancel = vi.fn();
    finish(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });

  it('times out a stalled response stream without waiting for its uncooperative cancel handler', async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    await expect(
      webRequestText('https://fixture.invalid/read', { cookie: '', timeoutMs: 5 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('cancels a fetch which ignores AbortSignal without beginning another attempt', async () => {
    const fetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = webRequestBytes('https://fixture.invalid/read', {
      cookie: '',
      signal: controller.signal,
      retry: { maxAttempts: 2 },
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('does not start a retry when its wait would exceed the total elapsed budget', async () => {
    const fetch = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      webRequestText('https://fixture.invalid/read', {
        cookie: '',
        timeoutMs: 1000,
        totalTimeoutMs: 10,
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 100 },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('allows a timed-out attempt to retry only within the explicit total budget', async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(new Response(Uint8Array.of(0, 255, 42)));
    vi.stubGlobal('fetch', fetch);
    expect(
      await webRequestBytes('https://fixture.invalid/read', {
        cookie: '',
        timeoutMs: 5,
        totalTimeoutMs: 1000,
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).toEqual(Uint8Array.of(0, 255, 42));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])(
    'classifies HTTP %s as authentication and never retries it',
    async (status) => {
      const fetch = vi.fn(async () => new Response('denied', { status }));
      vi.stubGlobal('fetch', fetch);
      await expect(
        webRequestBytes('https://fixture.invalid/read?token=private', {
          cookie: '',
          retry: { maxAttempts: 3 },
        }),
      ).rejects.toMatchObject({ kind: 'authentication', status, retryable: false });
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it('sends binary bodies intact without changing caller headers or adding a retry to writes', async () => {
    const fetch = vi.fn(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      webRequestBytes('https://fixture.invalid/write', {
        method: 'POST',
        cookie: 'synthetic',
        body: Uint8Array.of(0, 255, 42),
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Cookie: 'synthetic', 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([0, 255, 42]),
    });
  });
});
