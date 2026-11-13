import { afterEach, expect, it, vi } from 'vitest';
import { forwardQzoneMsg, replyQzoneMsg } from '../src/account/web/qzone_write_actions';
import { WebQueryService } from '../src/account/web';

const cred = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };
const target = { rootId: '0', rootUin: '10002', uin: '10003', nickname: '甲%,}{:乙' };
afterEach(() => vi.unstubAllGlobals());
function transport(value: unknown = { code: 0 }) {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(value)),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}
function body(fetch: ReturnType<typeof transport>) {
  return new URLSearchParams(
    (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
  );
}
it('回复楼中楼保留零号根评论与根作者，独立编码目标昵称，图片沿用评论直链', async () => {
  const fetch = transport();
  await replyQzoneMsg(
    cred,
    '10004',
    'current-post',
    target,
    '正文',
    'https://example.com/image.jpg',
  );
  expect(fetch.mock.calls[0]?.[0]).toContain('emotion_cgi_re_feeds?g_tk=');
  expect(Object.fromEntries(body(fetch))).toMatchObject({
    hostUin: '10004',
    uin: '10001',
    topicId: '10004_current-post__1',
    feedsType: '100',
    commentId: '0',
    commentUin: '10002',
    format: 'json',
    content: '@{uin:10003,nick:甲%25%2C%7D%7B%3A乙,who:1,auto:1}正文',
    richtype: '1',
    richval: 'https://example.com/image.jpg',
  });
});
it('普通转发使用当前动态而非原帖，不夹带评论转发参数', async () => {
  const fetch = transport({ result: { code: 0 } });
  await forwardQzoneMsg(cred, '10004', 'current-post', '转发语');
  expect(fetch.mock.calls[0]?.[0]).toContain('emotion_cgi_forward_v6?g_tk=');
  expect(Object.fromEntries(body(fetch))).toMatchObject({
    tid: 'current-post',
    t1_uin: '10004',
    con: '转发语',
    with_cmt: '0',
    fwdToWeibo: '0',
    signin: '0',
    hostuin: '10001',
    format: 'fs',
  });
  expect(body(fetch).has('t2_tid')).toBe(false);
  expect(body(fetch).has('fwdtype')).toBe(false);
});
it.each([
  {},
  { code: '0' },
  { code: 0, subcode: 2 },
  { code: 0, result: { code: -1 } },
  { code: -10000 },
  { code: 0, needVerify: 1 },
  { code: 0, data: { needVerify: 1 } },
  { code: 0, verifyurl: 'https://example.com/verify' },
])('拒绝未知、错误或验证回包且不重发：%j', async (value) => {
  const fetch = transport(value);
  await expect(forwardQzoneMsg(cred, '10004', 'post', '')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it('网络失败不自动重试也不切换写入端点', async () => {
  const fetch = vi.fn(async () => {
    throw new Error('synthetic timeout');
  });
  vi.stubGlobal('fetch', fetch);
  await expect(replyQzoneMsg(cred, '10004', 'post', target, '正文')).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
it('根评论身份缺失时在联网前拒绝', async () => {
  const fetch = transport();
  await expect(
    replyQzoneMsg(cred, '10004', 'post', { ...target, rootId: '0_r_1_10002' }, '正文'),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
it('解析官方 FormSender 对象字面量回调，不执行远程脚本', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response("<script>frameElement.callback({result:{code:0,msg:'ok'}});</script>"),
    ),
  );
  await expect(forwardQzoneMsg(cred, '10004', 'post', '')).resolves.toBeUndefined();
});
it('即使登录网页含有 code=0 的脚本也不当成功', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('<html><script>window.config={code:0}</script></html>')),
  );
  await expect(forwardQzoneMsg(cred, '10004', 'post', '')).rejects.toThrow('网页');
});
it('仅显式票据拒绝换票一次，每次发包前重新校验账号，限流不重发', async () => {
  const fetch = transport();
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: -3000 })));
  const service = Object.create(WebQueryService.prototype) as WebQueryService;
  const creds = { forDomain: vi.fn(async () => cred), invalidate: vi.fn() };
  Reflect.set(service, 'creds', creds);
  const current = vi.fn();
  await service.forwardQzone('10004', 'post', '', current);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(creds.invalidate).toHaveBeenCalledOnce();
  expect(current).toHaveBeenCalledTimes(2);
  fetch.mockClear().mockResolvedValue(new Response(JSON.stringify({ code: -10000 })));
  await expect(service.forwardQzone('10004', 'post', '', current)).rejects.toThrow();
  expect(fetch).toHaveBeenCalledOnce();
});
