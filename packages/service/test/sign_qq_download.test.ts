/**
 * `sign-qq-download` —— 给 QQ 下载地址换带签名的短时链接。
 *
 * 官网 `pcConfig.json` 里的 `qqdl.gtimg.cn/qqfile/QQNTV2/...` 直接 GET 会 403；
 * 页面的真实做法是先 POST 到内部接口拿 `?sign=&t=`。这里锁三件事：
 *   1. 请求形态（URL / content-type / x-oidb / body）—— 少一样接口就回 1001/4001；
 *   2. 成功时取 `data.url`，失败时抛带 retcode 的错误；
 *   3. 已经签过的地址原样返回（调用方可以无脑重复调用）。
 *
 * 全部用 stub fetch，不联网。
 */
import { describe, expect, it, vi } from 'vitest';
import { SignError, signQqUrl } from '../../scripts/sign-qq-download.mjs';

const ENDPOINT = 'https://im.qq.com/http2rpc/gotrpc/noauth/trpc.qqntv2.urlsign.UrlSign/GetSign';
const ORIGINAL =
  'https://qqdl.gtimg.cn/qqfile/QQNTV2/9.9.37/release/816b3c79/QQ_3.2.35_261103_amd64_01.deb';
const SIGNED = `${ORIGINAL}?sign=abc123&t=1794148670`;

function stub(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }));
}

describe('signQqUrl', () => {
  it('用正确的请求形态拿到签名地址', async () => {
    const fetchImpl = stub({ retcode: 0, data: { url: SIGNED } });
    await expect(signQqUrl(ORIGINAL, { fetchImpl })).resolves.toBe(SIGNED);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      // 缺这个头会回 retcode 1001，接口形态变了时这里先炸。
      'x-oidb': '{"uint32_command":"0x9b8e","uint32_service_type":1}',
    });
    expect(JSON.parse(init.body as string)).toEqual({ url: ORIGINAL });
  });

  it('已经带 sign 的地址原样返回，不再请求', async () => {
    const fetchImpl = stub({});
    await expect(signQqUrl(SIGNED, { fetchImpl })).resolves.toBe(SIGNED);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('retcode 非 0 时抛带 retcode 的 SignError', async () => {
    const fetchImpl = stub({ retcode: 4001, msg: 'not authorized!' });
    await expect(signQqUrl(ORIGINAL, { fetchImpl })).rejects.toBeInstanceOf(SignError);
    await expect(signQqUrl(ORIGINAL, { fetchImpl })).rejects.toMatchObject({ retcode: 4001 });
  });

  it('返回里没有 data.url 也算失败', async () => {
    await expect(
      signQqUrl(ORIGINAL, { fetchImpl: stub({ retcode: 0, data: {} }) }),
    ).rejects.toThrow(/data\.url/);
  });

  it('接口 HTTP 非 2xx 时抛错', async () => {
    await expect(
      signQqUrl(ORIGINAL, { fetchImpl: stub({}, { ok: false, status: 502 }) }),
    ).rejects.toThrow(/502/);
  });

  it('非法 URL 直接拒绝，不发请求', async () => {
    const fetchImpl = stub({});
    await expect(signQqUrl('not-a-url', { fetchImpl })).rejects.toBeInstanceOf(SignError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
