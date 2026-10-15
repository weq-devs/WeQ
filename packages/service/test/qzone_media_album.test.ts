import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchQzonePostAlbum,
  parseQzoneAlbumName,
  parseQzonePostAlbum,
} from '../src/account/web/qzone_media_album';

const wire = (value: unknown) => `_Callback(${JSON.stringify(value)});`;
const feed = { uin: '10002', skey: 'post', albumid: 'album', albumname: '旅行' };
afterEach(() => vi.unstubAllGlobals());
describe('post media album', () => {
  it('binds exact owner and post, ignoring nulls and unrelated entries', () => {
    expect(
      parseQzonePostAlbum(
        wire({
          code: 0,
          data: { feeds: [null, { ...feed, uin: '10003' }, { ...feed, skey: 'other' }, feed] },
        }),
        '10002',
        'post',
      ),
    ).toEqual({ hostUin: '10002', topicId: 'album', name: '旅行' });
    expect(
      parseQzonePostAlbum(
        wire({ code: 0, data: { feeds: [{ ...feed, skey: 'other' }] } }),
        '10002',
        'post',
      ),
    ).toBeNull();
  });
  it('rejects ambiguous album associations and malformed/error envelopes', () => {
    for (const value of [
      { code: 0, data: { feeds: [feed, { ...feed, albumid: 'other' }] } },
      { code: 0 },
      { data: { feeds: [] } },
      { code: -3000 },
    ])
      expect(() => parseQzonePostAlbum(wire(value), '10002', 'post')).toThrow();
  });
  it('validates album identity and name without returning permission or answer fields', () => {
    expect(
      parseQzoneAlbumName(
        wire({ code: 0, data: { album: { id: 'album', name: '照片', answer: 'private' } } }),
        'album',
      ),
    ).toBe('照片');
    for (const album of [{ id: 'other', name: 'bad' }, { id: 'album' }, { id: 'album', name: '' }])
      expect(() => parseQzoneAlbumName(wire({ code: 0, data: { album } }), 'album')).toThrow();
  });
  it('requests one feed response and only the exact unnamed album, propagating cancellation', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(wire({ code: 0, data: { feeds: [{ ...feed, albumname: '' }] } })),
      )
      .mockResolvedValueOnce(
        new Response(wire({ code: 0, data: { album: { id: 'album', name: '照片' } } })),
      );
    vi.stubGlobal('fetch', fetch);
    expect(
      await fetchQzonePostAlbum(
        { uin: '10001', skey: 'synthetic', pskey: 'synthetic' },
        '10002',
        'post',
      ),
    ).toEqual({ hostUin: '10002', topicId: 'album', name: '照片' });
    const urls = fetch.mock.calls.map((c) => new URL(c[0]));
    expect(urls[0]!.searchParams.get('uin')).toBe('10001');
    expect(urls[0]!.searchParams.get('fuin')).toBe('10002');
    expect(urls[1]!.searchParams.get('albumId')).toBe('album');
    expect(urls[1]!.searchParams.get('uin')).toBe('10002');
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      fetchQzonePostAlbum(
        { uin: '10001', skey: 'synthetic', pskey: 'synthetic' },
        '10002',
        'post',
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
