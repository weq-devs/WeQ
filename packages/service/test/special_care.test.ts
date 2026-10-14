import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSpecialCare, parseSpecialCare } from '../src/account/web/special_care';
import { computeBkn, WebAuthError } from '../src/account/web/credential';

const credential = { uin: '10001', skey: 'synthetic-skey', pskey: 'synthetic-pskey' };
function response(items: unknown[] = [], count: unknown = 0) {
  return {
    code: 0,
    subcode: 0,
    data: {
      items_special: items,
      items_recommend: [{ uin: 10009, name: 'Not special' }],
      fans_count: [{ fans_count: count }],
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('Qzone special care', () => {
  it('reads the observed JSONP shape without mixing recommendations or filtering tipon', () => {
    expect(
      parseSpecialCare(
        `_Callback(${JSON.stringify(
          response(
            [
              { uin: 10002, name: 'First', tipon: 0 },
              { uin: 10003, name: 'Second', tipon: 1 },
              { uin: '10002', name: 'Duplicate' },
            ],
            3,
          ),
        )});`,
      ),
    ).toEqual({
      items: [
        { uin: '10002', name: 'First' },
        { uin: '10003', name: 'Second' },
      ],
      fansCount: 3,
    });
  });
  it('distinguishes a confirmed empty list and zero fans from missing or invalid fields', () => {
    expect(parseSpecialCare(JSON.stringify(response()))).toEqual({ items: [], fansCount: 0 });
    expect(parseSpecialCare('{code:0,data:{items_special:[]}}').fansCount).toBeNull();
    for (const count of [null, '3', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(parseSpecialCare(JSON.stringify(response([], count))).fansCount).toBeNull();
    }
    expect(() => parseSpecialCare('{code:0,data:{}}')).toThrow('结构异常');
    expect(() => parseSpecialCare('{code:0,data:{items_special:null}}')).toThrow('结构异常');
  });
  it('rejects bad identities and unsafe numeric UINs without silently dropping contacts', () => {
    for (const uin of ['0', 'invalid', null, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseSpecialCare(JSON.stringify(response([{ uin }])))).toThrow('名单结构异常');
    }
  });
  it('uses credential retry classification for expired authentication and rejects other failures', () => {
    for (const code of [-3000, -10000])
      expect(() => parseSpecialCare(JSON.stringify({ code }))).toThrow(WebAuthError);
    expect(() => parseSpecialCare('{code:1}')).toThrow('无法读取');
    expect(() => parseSpecialCare('{code:0,subcode:1}')).toThrow('无法读取');
    expect(() => parseSpecialCare('<html>login</html>')).toThrow();
    expect(() => parseSpecialCare('_Callback((()=>process.exit())())')).toThrow();
  });
  it('requests the current account with one computed token and existing cookies', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response([], 3))));
    vi.stubGlobal('fetch', fetch);
    expect(await getSpecialCare(credential)).toEqual({ items: [], fansCount: 3 });
    const [url, options] = fetch.mock.calls[0]! as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://r.qzone.qq.com/cgi-bin/tfriend/specialcare_get.cgi',
    );
    expect(parsed.searchParams.get('uin')).toBe(credential.uin);
    expect(parsed.searchParams.get('do')).toBe('3');
    expect(parsed.searchParams.get('fupdate')).toBe('1');
    expect(parsed.searchParams.getAll('g_tk')).toEqual([String(computeBkn(credential.pskey))]);
    expect(new Headers(options.headers).get('cookie')).toContain('p_skey=synthetic-pskey');
  });
});
