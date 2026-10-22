import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchQzoneContentCounts,
  fetchQzoneVisitorCount,
  parseQzoneContentCounts,
  parseQzoneVisitorCount,
  parseQzoneVisitorStats,
} from '../src/account/web/qzone_stats';
import { parseQzoneLikesResult } from '../src/account/web/qzone_interaction';
import { WebAuthError } from '../src/account/web/credential';
import { WebQueryService } from '../src/account/web';

const credential = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };
const content = (SS: unknown, XC: unknown) => ({
  code: 0,
  data: { module_16: { data: { SS, XC } } },
});
const visits = (totalcount: unknown) => ({
  code: 0,
  data: { modvisitcount: [{ mod: 0, totalcount, todaycount: 2 }] },
});
const stringify = (value: unknown) => `_Callback(${JSON.stringify(value)});`;
afterEach(() => vi.unstubAllGlobals());

describe('Qzone space statistics', () => {
  it('只采用唯一 mod=0 的累计与今日访问人次，不将唯一无标识记录猜作空间统计', () => {
    expect(
      parseQzoneVisitorStats(
        stringify({
          code: 0,
          data: {
            modvisitcount: [
              { mod: 1, totalcount: 999 },
              { mod: 0, totalcount: 20, todaycount: 3 },
            ],
          },
        }),
      ),
    ).toEqual({ totalCount: 20, todayCount: 3 });
    for (const rows of [
      [{ totalcount: 8 }],
      [
        { mod: 0, totalcount: 1 },
        { mod: 0, totalcount: 2 },
      ],
    ])
      expect(parseQzoneVisitorStats(stringify({ code: 0, data: { modvisitcount: rows } }))).toEqual(
        { totalCount: null, todayCount: null },
      );
  });
  it('reads service totals, including explicit zero and numeric strings', () => {
    expect(parseQzoneContentCounts(stringify(content(0, '12345')))).toEqual({
      postCount: 0,
      photoCount: 12345,
    });
    expect(parseQzoneVisitorCount(stringify(visits('54321')))).toBe(54321);
    expect(parseQzoneVisitorCount(stringify(visits(0)))).toBe(0);
  });
  it('does not turn absent or malformed fields into zero', () => {
    for (const value of [
      undefined,
      null,
      '',
      ' ',
      false,
      -1,
      1.5,
      '1.5',
      'NaN',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(parseQzoneContentCounts(stringify(content(value, value)))).toEqual({
        postCount: null,
        photoCount: null,
      });
      expect(parseQzoneVisitorCount(stringify(visits(value)))).toBeNull();
    }
    expect(
      parseQzoneVisitorCount(stringify({ code: 0, data: { total: 123, items: [{}, {}] } })),
    ).toBeNull();
    expect(
      parseQzoneVisitorCount(
        stringify({ code: 0, data: { modvisitcount: [{ totalcount: 1 }, { totalcount: 2 }] } }),
      ),
    ).toBeNull();
  });
  it('rejects failed, unauthenticated and unsuccessful module responses', () => {
    for (const value of [{ code: -10031 }, {}, { code: 0, error: { type: -6 } }]) {
      expect(() => parseQzoneContentCounts(stringify(value))).toThrow();
      expect(() => parseQzoneVisitorCount(stringify(value))).toThrow();
    }
    expect(() => parseQzoneVisitorCount(stringify({ error: { type: -3 } }))).toThrow(WebAuthError);
    expect(() => parseQzoneContentCounts(stringify({ code: -3000 }))).toThrow(WebAuthError);
    expect(() =>
      parseQzoneContentCounts(
        stringify({ code: 0, data: { module_16: { code: 1, data: { SS: 5 } } } }),
      ),
    ).toThrow();
  });
  it('requests only target-space totals with the viewer credential and abort signal', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(stringify(content(8, 9))))
      .mockResolvedValueOnce(new Response(stringify(visits(10))));
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    expect(await fetchQzoneContentCounts(credential, '10002', controller.signal)).toEqual({
      postCount: 8,
      photoCount: 9,
    });
    expect(await fetchQzoneVisitorCount(credential, '10002', controller.signal)).toBe(10);
    const urls = fetch.mock.calls.map(([url]) => new URL(url));
    expect(urls[0]!.searchParams.get('param')).toBe('16');
    expect(urls[1]!.searchParams.get('mask')).toBe('1');
    for (const url of urls) expect(url.searchParams.get('uin')).toBe('10002');
  });
  it('reads content totals without requesting visitor information', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain('main_page_cgi');
      return new Response(stringify(content(8, 9)));
    });
    vi.stubGlobal('fetch', fetch);
    const service = Object.create(WebQueryService.prototype) as WebQueryService;
    Reflect.set(service, 'creds', { forDomain: async () => credential });
    expect(await service.getQzoneSpaceStats('10002')).toEqual({
      postCount: 8,
      photoCount: 9,
      totalCount: null,
      todayCount: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to visitor reads when content counts are unavailable', async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toContain('main_page_cgi');
      return new Response(stringify({ code: -10031 }));
    });
    vi.stubGlobal('fetch', fetch);
    const service = Object.create(WebQueryService.prototype) as WebQueryService;
    Reflect.set(service, 'creds', { forDomain: async () => credential });
    expect(await service.getQzoneSpaceStats('10002')).toEqual({
      postCount: null,
      photoCount: null,
      totalCount: null,
      todayCount: null,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not swallow cancellation while reading content counts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('synthetic cancellation'));
    const service = Object.create(WebQueryService.prototype) as WebQueryService;
    Reflect.set(service, 'creds', { forDomain: async () => credential });
    await expect(service.getQzoneSpaceStats('10002', controller.signal)).rejects.toThrow(
      'synthetic cancellation',
    );
  });
});

describe('Qzone post views', () => {
  const response = (PRD: unknown, code: number | undefined = 0) =>
    stringify({ code, data: [{ current: { newdata: { PRD }, likedata: { cnt: 0 } } }] });
  it('reads PRD independently of likes and comments, preserving explicit zero', () => {
    expect(parseQzoneLikesResult(response(123))).toMatchObject({
      reportedViewCount: 123,
      reportedTotal: 0,
    });
    expect(parseQzoneLikesResult(response(0)).reportedViewCount).toBe(0);
  });
  it('keeps unsupported values unknown and requires an accepted single-post response', () => {
    for (const value of [undefined, null, '', '123', -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(parseQzoneLikesResult(response(value)).reportedViewCount).toBeNull();
    expect(
      parseQzoneLikesResult(stringify({ data: [{ current: { newdata: { PRD: 123 } } }] }))
        .reportedViewCount,
    ).toBeNull();
    expect(
      parseQzoneLikesResult(
        stringify({ code: 0, data: [{ current: { newdata: { PRD: 123 } } }, {}] }),
      ).reportedViewCount,
    ).toBeNull();
  });
});
