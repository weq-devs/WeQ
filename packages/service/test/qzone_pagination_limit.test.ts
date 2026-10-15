import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from '@weq/platform';
import {
  QzonePaginationLimiter,
  normalizeQzonePagination,
  isQzonePageRequest,
} from '../src/common/qzone_pagination';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Qzone sliding page quota', () => {
  it('admits five pages immediately and the sixth only after ten seconds', async () => {
    const limiter = new QzonePaginationLimiter();
    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
    let admitted = false;
    const sixth = limiter.acquire().then(() => {
      admitted = true;
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await sixth;
    expect(admitted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses a rolling window rather than resetting at a wall-clock boundary', async () => {
    const limiter = new QzonePaginationLimiter();
    await Promise.all(Array.from({ length: 3 }, () => limiter.acquire()));
    await vi.advanceTimersByTimeAsync(9000);
    await Promise.all([limiter.acquire(), limiter.acquire()]);
    const done: number[] = [];
    const queued = Array.from({ length: 5 }, (_, index) =>
      limiter.acquire().then(() => done.push(index)),
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toEqual([0, 1, 2]);
    await vi.advanceTimersByTimeAsync(8999);
    expect(done).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(queued);
    expect(done).toEqual([0, 1, 2, 3, 4]);
  });
  it('cancels a queued page without sending it or consuming the next slot', async () => {
    const limiter = new QzonePaginationLimiter();
    limiter.configure({ windowSeconds: 10, maxPages: 1 });
    await limiter.acquire();
    const controller = new AbortController();
    const cancelled = limiter.acquire(controller.signal).catch((error) => error.message);
    let admitted = false;
    const next = limiter.acquire().then(() => {
      admitted = true;
    });
    controller.abort(new Error('synthetic cancel'));
    expect(await cancelled).toBe('synthetic cancel');
    await vi.advanceTimersByTimeAsync(10000);
    await next;
    expect(admitted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await expect(limiter.acquire(controller.signal)).rejects.toThrow('synthetic cancel');
  });
  it('applies edits to waiting work without erasing previous admissions', async () => {
    const limiter = new QzonePaginationLimiter();
    await Promise.all(Array.from({ length: 5 }, () => limiter.acquire()));
    let admitted = false;
    const sixth = limiter.acquire().then(() => {
      admitted = true;
    });
    limiter.configure({ windowSeconds: 20, maxPages: 5 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(admitted).toBe(false);
    limiter.configure({ windowSeconds: 20, maxPages: 6 });
    await sixth;
    expect(admitted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('normalizes old or invalid configuration without allowing zero/fractional budgets', () => {
    expect(normalizeQzonePagination(undefined)).toEqual({ windowSeconds: 10, maxPages: 5 });
    for (const value of [0, -1, 1.5, Infinity, NaN, 100000])
      expect(normalizeQzonePagination({ windowSeconds: value, maxPages: value })).toEqual({
        windowSeconds: 10,
        maxPages: 5,
      });
    expect(normalizeQzonePagination({ maxPages: 8 }, { windowSeconds: 20, maxPages: 3 })).toEqual({
      windowSeconds: 20,
      maxPages: 8,
    });
  });
  it('classifies page requests including first pages, not counts, writes, details or CDN files', () => {
    for (const path of [
      '/cgi-bin/emotion_cgi_msglist_v6',
      '/cgi-bin/emotion_cgi_getcmtreply_v6',
      '/cgi-bin/feeds/feeds_html_act_all',
      '/cgi-bin/feeds/feeds2_html_pav_all',
      '/fcgi-bin/fcg_list_album_v3',
      '/fcgi-bin/cgi_list_photo',
    ])
      expect(
        isQzonePageRequest(`https://user.qzone.qq.com/proxy/domain/taotao.qq.com${path}?pos=0`),
      ).toBe(true);
    for (const path of [
      '/cgi-bin/user/qz_opcnt2',
      '/cgi-bin/main_page_cgi',
      '/cgi-bin/emotion_cgi_publish_v6',
      '/cgi-bin/emotion_cgi_msgdetail_v6',
      '/fcgi-bin/cgi_floatview_photo_list_v2',
    ])
      expect(
        isQzonePageRequest(`https://user.qzone.qq.com/proxy/domain/taotao.qq.com${path}`),
      ).toBe(false);
    expect(isQzonePageRequest('https://evil.test/cgi-bin/emotion_cgi_msglist_v6')).toBe(false);
  });
});

describe('Qzone quota transport and persistence', () => {
  const pageUrl =
    'https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?pos=0';
  it('holds real dispatches across URLs, excludes queue time from network deadlines and leaves non-pages alone', async () => {
    vi.resetModules();
    const { qzonePaginationLimiter } = await import('../src/common/qzone_pagination');
    const { webRequestText } = await import('../src/account/web/http');
    qzonePaginationLimiter.configure({ windowSeconds: 10, maxPages: 1 });
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await webRequestText(pageUrl, { cookie: 'synthetic', timeoutMs: 100 });
    const second = webRequestText(pageUrl.replace('pos=0', 'pos=20'), {
      cookie: 'synthetic',
      timeoutMs: 100,
    });
    await webRequestText(pageUrl.replace('emotion_cgi_msglist_v6', 'user/qz_opcnt2'), {
      cookie: 'synthetic',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await second).toBe('{}');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('charges retries as page requests instead of bypassing the quota', async () => {
    vi.resetModules();
    const { qzonePaginationLimiter } = await import('../src/common/qzone_pagination');
    const { webRequestText } = await import('../src/account/web/http');
    qzonePaginationLimiter.configure({ windowSeconds: 10, maxPages: 1 });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    const result = webRequestText(pageUrl, { cookie: 'synthetic', retry: { maxAttempts: 2 } });
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('{}');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('cancels before fetch while keeping non-cancelled queued work usable', async () => {
    vi.resetModules();
    const { qzonePaginationLimiter } = await import('../src/common/qzone_pagination');
    const { webRequestText } = await import('../src/account/web/http');
    qzonePaginationLimiter.configure({ windowSeconds: 10, maxPages: 1 });
    const fetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await webRequestText(pageUrl, { cookie: 'synthetic' });
    const controller = new AbortController();
    const result = webRequestText(pageUrl, {
      cookie: 'synthetic',
      signal: controller.signal,
    }).catch((error) => error.kind);
    controller.abort();
    expect(await result).toBe('cancelled');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pauses the operation watchdog for quota waits but still times out network work', async () => {
    vi.resetModules();
    const { qzonePaginationLimiter, waitForQzonePage, withQzonePaginationTimeout } = await import(
      '../src/common/qzone_pagination'
    );
    qzonePaginationLimiter.configure({ windowSeconds: 10, maxPages: 1 });
    await waitForQzonePage();
    const controller = new AbortController();
    const done = withQzonePaginationTimeout(controller, 100, async () => {
      await waitForQzonePage(controller.signal);
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    });
    await vi.advanceTimersByTimeAsync(10000);
    expect(controller.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(controller.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('persists both values and applies saved settings on startup', async () => {
    vi.resetModules();
    const { UserConfigService } = await import('../src/bootstrap/user_config');
    const root = mkdtempSync(join(tmpdir(), 'weq-pagination-'));
    try {
      const platform = { appDataRoot: () => root } as Platform;
      const config = new UserConfigService(platform);
      expect(config.getSettings().qzonePagination).toEqual({ windowSeconds: 10, maxPages: 5 });
      config.setSettings({ qzonePagination: { windowSeconds: 25, maxPages: 3 } });
      config.setSettings({ preferCdn: true });
      expect(new UserConfigService(platform).getSettings().qzonePagination).toEqual({
        windowSeconds: 25,
        maxPages: 3,
      });
      expect(config.setSettings({ qzonePagination: { maxPages: 0 } }).qzonePagination).toEqual({
        windowSeconds: 25,
        maxPages: 3,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
