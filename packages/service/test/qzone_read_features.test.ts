import { afterEach, describe, expect, it, vi } from 'vitest';
import { getQzoneFeeds, mapMsgList } from '../src/account/web/qzone';
import {
  fetchQzonePostDetail,
  fetchQzonePostImages,
  parseQzonePostDetail,
  parseQzonePostImages,
} from '../src/account/web/qzone_detail';
import {
  fetchQzoneRelated,
  fetchQzoneMemories,
  parseQzoneRecall,
} from '../src/account/web/qzone_recall';
import {
  getQzoneAlbumDetail,
  getQzoneAlbumPage,
  parseQzoneAlbumPage,
} from '../src/account/web/qzone_album';

const cred = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };
const jsonp = (value: unknown) => `_Callback(${JSON.stringify(value)});`;
function mockBody(value: unknown) {
  const fetch = vi.fn(async (_url: string) => new Response(jsonp(value)));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe('post completion', () => {
  it('retains explicit truncation and declared image totals', () => {
    expect(
      mapMsgList({
        msglist: [
          {
            tid: 'synthetic',
            has_more_con: 1,
            pictotal: 12,
            rt_tid: 'original',
            rt_has_more_con: 1,
          },
        ],
      }).list[0],
    ).toMatchObject({ contentTruncated: true, imageTotal: 12, repost: { contentTruncated: true } });
    expect(mapMsgList({ msglist: [{ tid: 'synthetic' }] }).list[0]).toMatchObject({
      contentTruncated: false,
      imageTotal: null,
    });
  });
  it('does not count a top-level video as a returned pic entry', () => {
    expect(
      mapMsgList({
        msglist: [
          {
            tid: 'synthetic',
            pictotal: 2,
            pic: [{ url3: 'https://a.qpic.cn/a' }],
            video: [{ url3: 'https://a.qq.com/video.mp4' }],
          },
        ],
      }).list[0],
    ).toMatchObject({ imageTotal: 2, imageReturned: 1 });
  });
  it('requires an explicit cleared truncation flag to declare full content', () => {
    expect(
      parseQzonePostDetail(
        jsonp({ code: 0, tid: 'synthetic', uin: 10002, content: 'full', has_more_con: 0 }),
        '10002',
        'synthetic',
      ),
    ).toMatchObject({ content: 'full', contentComplete: true });
    expect(
      parseQzonePostDetail(jsonp({ code: 0, content: 'longer' }), '10002', 'synthetic'),
    ).toMatchObject({ content: 'longer', contentComplete: false });
  });
  it('rejects wrong owner/post, rejected or absent content', () => {
    for (const data of [
      { code: -10031 },
      { content: 'bad' },
      { code: 0 },
      { code: 0, tid: 'other', content: 'bad' },
      { code: 0, uin: 10003, content: 'bad' },
    ])
      expect(() => parseQzonePostDetail(jsonp(data), '10002', 'synthetic')).toThrow();
  });
  it('preserves R04 order and rejects malformed or mismatched results', () => {
    expect(
      parseQzonePostImages(jsonp({ code: 0, imageUrls: ['a', 'b', 'a'] }), '10002', 'synthetic'),
    ).toEqual(['a', 'b']);
    for (const imageUrls of [undefined, [1], ['']])
      expect(() =>
        parseQzonePostImages(jsonp({ code: 0, imageUrls }), '10002', 'synthetic'),
      ).toThrow();
    expect(() =>
      parseQzonePostImages(jsonp({ code: 0, tid: 'other', imageUrls: [] }), '10002', 'synthetic'),
    ).toThrow();
  });
  it('keeps viewer and target identities separate in R02/R04 requests', async () => {
    let fetch = mockBody({ code: 0, content: 'full', has_more_con: 0 });
    await fetchQzonePostDetail(cred, '10002', 'synthetic');
    let url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toContain('emotion_cgi_msgdetail_v6');
    expect(url.searchParams.get('uin')).toBe('10002');
    expect(url.searchParams.get('hostuin')).toBe('10001');
    expect(url.searchParams.get('not_trunc_con')).toBe('1');
    fetch = mockBody({ code: 0, imageUrls: [] });
    await fetchQzonePostImages(cred, '10002', 'synthetic');
    url = new URL(fetch.mock.calls[0]![0]);
    expect(url.pathname).toContain('emotion_cgi_get_pics_v6');
    expect(url.searchParams.get('tid')).toBe('synthetic');
  });
});

describe('separate feed recipes', () => {
  it('uses scope=7 with the original continuation protocol', async () => {
    const fetch = mockBody({ code: 0, data: { data: [], main: { hasMoreFeeds: false } } });
    await getQzoneFeeds(cred, cred.uin, 1, 10, undefined, 'basetime=123&pagenum=2', 7);
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.searchParams.get('scope')).toBe('7');
    expect(url.searchParams.get('pagenum')).toBe('2');
    expect(url.searchParams.get('externparam')).toBe('basetime=123&pagenum=2');
  });
  it('accepts only a forward bounded R17 server offset', () => {
    for (const offset of [undefined, 0, 9, 100001, 'bogus'])
      expect(
        parseQzoneRecall(
          jsonp({ code: 0, data: { data: [], main: { hasMoreFeeds: 1, offset } } }),
          'related',
          10,
        ),
      ).toMatchObject({ nextCursor: undefined, incomplete: true });
    expect(
      parseQzoneRecall(
        jsonp({ code: 0, data: { data: [], main: { hasMoreFeeds: 1, offset: '27' } } }),
        'related',
        10,
      ),
    ).toMatchObject({ nextCursor: 'offset=27', incomplete: false });
  });
  it('distinguishes failed/absent data from an accepted empty page', () => {
    for (const data of [{}, { code: -3000 }, { code: 0, data: {} }])
      expect(() => parseQzoneRecall(jsonp(data), 'related')).toThrow();
    expect(
      parseQzoneRecall(
        jsonp({ code: 0, data: { data: [], main: { hasMoreFeeds: 0 } } }),
        'related',
      ),
    ).toMatchObject({ feeds: [], hasMore: false });
  });
  it('collects R18 groups without inventing continuation', () => {
    const feed = { uin: 10002, appid: 311, key: 'synthetic', html: '<p>fixture</p>' };
    expect(
      parseQzoneRecall(
        jsonp({
          code: 0,
          data: { host_data: [feed], friend_data: [feed], main: { hasMoreFeeds_1: 1 } },
        }),
        'memories',
      ),
    ).toMatchObject({
      feeds: expect.any(Array),
      hasMore: true,
      nextCursor: undefined,
      incomplete: true,
    });
  });
  it('keeps recall year and related offset protocols separate, without clear=1', async () => {
    let fetch = mockBody({ code: 0, data: { data: [], main: {} } });
    await fetchQzoneRelated(cred, 27);
    let url = new URL(fetch.mock.calls[0]![0]);
    expect(url.searchParams.get('offset')).toBe('27');
    expect(url.searchParams.has('clear')).toBe(false);
    fetch = mockBody({ code: 0, data: { host_data: [], main: {} } });
    await fetchQzoneMemories(cred, 2020);
    url = new URL(fetch.mock.calls[0]![0]);
    expect(url.searchParams.get('year')).toBe('2020');
    expect(url.searchParams.get('login_uin')).toBe('10001');
    expect(url.searchParams.has('offset')).toBe(false);
  });
});

describe('album deep pages and exact detail', () => {
  it('continues short pages before the declared total, flags early emptiness', () => {
    expect(
      parseQzoneAlbumPage(
        jsonp({ code: 0, data: { albumsInUser: 5, albumList: [{ id: 'one' }] } }),
        0,
        40,
      ),
    ).toMatchObject({ total: 5, nextOffset: 1, warning: null });
    expect(
      parseQzoneAlbumPage(jsonp({ code: 0, data: { albumsInUser: 5, albumList: [] } }), 1, 40),
    ).toMatchObject({ nextOffset: null, warning: expect.stringContaining('提前结束') });
  });
  it('preserves unknown totals and stops at the observed end', () => {
    expect(
      parseQzoneAlbumPage(
        jsonp({ code: 0, data: { albumList: [{ id: 'one' }, { id: 'two' }] } }),
        0,
        2,
      ),
    ).toMatchObject({ total: null, nextOffset: 2 });
    expect(
      parseQzoneAlbumPage(jsonp({ code: 0, data: { albumList: [{ id: 'three' }] } }), 2, 2),
    ).toMatchObject({ total: null, nextOffset: null });
  });
  it('validates album identities and does not replace an explicit empty list with stale legacy data', () => {
    expect(
      parseQzoneAlbumPage(
        jsonp({
          code: 0,
          data: { albumList: [], albumListModeSort: [{ id: 'stale' }], albumsInUser: 0 },
        }),
        0,
        40,
      ).albums,
    ).toEqual([]);
    for (const data of [{}, { albumList: [{}] }, { albumList: [{ id: 'same' }, { id: 'same' }] }])
      expect(() => parseQzoneAlbumPage(jsonp({ code: 0, data }), 0, 40)).toThrow();
  });
  it('uses ordered offset-based R20 pagination and a bounded page size', async () => {
    const fetch = mockBody({ code: 0, data: { albumsInUser: 80, albumList: [{ id: 'a' }] } });
    await getQzoneAlbumPage(cred, '10002', 40, 40);
    const url = new URL(fetch.mock.calls[0]![0]);
    expect(url.searchParams.get('pageStart')).toBe('40');
    expect(url.searchParams.get('pageNum')).toBe('40');
    expect(url.searchParams.get('mode')).toBe('2');
    expect(url.searchParams.get('hostUin')).toBe('10002');
    expect(url.searchParams.get('uin')).toBe('10001');
  });
  it('does not substitute an unrelated video for the requested R22 key', async () => {
    mockBody({
      code: 0,
      data: {
        photos: [
          {
            picKey: 'wrong',
            is_video: 1,
            video_info: { download_url: 'https://a.qq.com/wrong.mp4' },
          },
          { picKey: 'wanted', raw: 'https://a.qpic.cn/original', width: 1920, height: 1080 },
        ],
      },
    });
    expect(await getQzoneAlbumDetail(cred, '10002', 'album', 'wanted')).toMatchObject({
      imageUrl: 'https://a.qpic.cn/original',
      videoUrl: '',
      width: 1920,
      height: 1080,
    });
    await expect(getQzoneAlbumDetail(cred, '10002', 'album', 'missing')).rejects.toThrow('定位键');
  });
  it('requires a success code for R22', async () => {
    mockBody({ data: { photos: [{ picKey: 'wanted' }] } });
    await expect(getQzoneAlbumDetail(cred, '10002', 'album', 'wanted')).rejects.toThrow();
  });
});
