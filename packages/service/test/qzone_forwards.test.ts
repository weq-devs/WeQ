import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchQzoneForwardPage, parseQzoneForwardPage } from '../src/account/web/qzone_forwards';
import { WebAuthError } from '../src/account/web/credential';

const row = (uin = '10002', text = '合成转发语') => ({
  user: { uin, nickname: '合成用户' },
  forward_text: text,
  mapExtend: {},
});
const page = (list: unknown[] = [row()], extra = {}) => ({
  ret: 0,
  data: {
    list,
    friend_num: 1,
    total_num: 1288,
    attach_info: 'opaque,20',
    hasmore: 1,
    ...extra,
  },
});
const cred = { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };
afterEach(() => vi.unstubAllGlobals());

describe('空间转发者名单', () => {
  it('还原用户与转发语，不编造转发帖 ID 或时间', () => {
    const result = parseQzoneForwardPage(page());
    expect(result).toMatchObject({
      reportedTotal: 1288,
      rawCount: 1,
      hasMore: true,
      stopReason: null,
    });
    expect(result.forwards[0]).toMatchObject({
      uin: '10002',
      nickname: '合成用户',
      content: '合成转发语',
      isFriend: true,
    });
    expect(result.forwards[0]).not.toHaveProperty('tid');
    expect(result.forwards[0]).not.toHaveProperty('time');
    expect(result.nextCursor).toMatchObject({
      attachInfo: 'opaque,20',
      previousPageKey: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
  it('游标仍变动但整页相同时立即停止，重复页不追加', () => {
    const first = parseQzoneForwardPage(page());
    const second = parseQzoneForwardPage(
      page([row()], { attach_info: 'opaque,40' }),
      first.nextCursor,
    );
    expect(second).toMatchObject({
      forwards: [],
      hasMore: true,
      nextCursor: null,
      stopReason: 'repeated-page',
    });
  });
  it('JSON 属性顺序变化不影响相同末页判定', () => {
    const first = parseQzoneForwardPage(page());
    const second = parseQzoneForwardPage(
      page([
        { mapExtend: {}, forward_text: '合成转发语', user: { nickname: '合成用户', uin: '10002' } },
      ]),
      first.nextCursor,
    );
    expect(second.stopReason).toBe('repeated-page');
  });
  it('用户相同但转发语不同仍是新页', () => {
    const first = parseQzoneForwardPage(page());
    expect(
      parseQzoneForwardPage(
        page([row('10002', '另一条转发语')], { attach_info: 'next' }),
        first.nextCursor,
      ).nextCursor,
    ).not.toBeNull();
  });
  it('只去重同一用户相同转发语，保留不同转发语和好友属性', () => {
    const result = parseQzoneForwardPage(
      page([row(), row(), row('10002', '另一条')], { friend_num: 2 }),
    );
    expect(result.forwards).toHaveLength(2);
    expect(result.forwards.map((entry) => entry.isFriend)).toEqual([true, false]);
  });
  it('行顺序不同不误认为相同页', () => {
    const a = row(),
      b = row('10003');
    const first = parseQzoneForwardPage(page([a, b]));
    expect(
      parseQzoneForwardPage(page([b, a], { attach_info: 'next' }), first.nextCursor).stopReason,
    ).toBeNull();
  });
  it('游标重复时停止但保留该页新记录', () => {
    const first = parseQzoneForwardPage(page());
    const next = parseQzoneForwardPage(page([row('10003')]), first.nextCursor);
    expect(next).toMatchObject({ stopReason: 'repeated-cursor', nextCursor: null });
    expect(next.forwards).toHaveLength(1);
  });
  it('hasmore=0 即结束，不要求恰好取得 total_num 条', () => {
    expect(parseQzoneForwardPage(page([row()], { hasmore: 0 }))).toMatchObject({
      stopReason: 'complete',
      nextCursor: null,
      reportedTotal: 1288,
    });
  });
  it('显式空名单与未知总数不混作失败或零总数', () => {
    const raw = page([], { friend_num: 0, total_num: undefined, hasmore: 0 });
    expect(parseQzoneForwardPage(raw)).toMatchObject({
      forwards: [],
      reportedTotal: null,
      stopReason: 'complete',
    });
  });
  it.each([
    {},
    { ret: 0 },
    page([], { friend_num: 0 }),
    page([row()], { attach_info: '' }),
    page([row()], { friend_num: 2 }),
    page([row()], { hasmore: '1' }),
    page([row()], { total_num: -1 }),
    page([{ user: { uin: 'bad' }, forward_text: '' }]),
    page([{ user: { uin: '10002' } }]),
  ])('不把缺失或畸形响应当空名单：%j', (raw) =>
    expect(() => parseQzoneForwardPage(raw)).toThrow('响应格式无效'),
  );
  it('保留鉴权失败与业务错误', () => {
    expect(() => parseQzoneForwardPage({ ret: -3000 })).toThrow(WebAuthError);
    expect(() => parseQzoneForwardPage({ ret: -10000 })).toThrow('服务错误');
  });
  it('实际请求使用登录者、完整业务键及不透明游标，不再调用旧 offset 接口', async () => {
    const cursor = parseQzoneForwardPage(page()).nextCursor!;
    const fetch = vi.fn(
      async (_url: string) => new Response(JSON.stringify(page([row()], { hasmore: 0 }))),
    );
    vi.stubGlobal('fetch', fetch);
    await fetchQzoneForwardPage(cred, '3000000000', 'synthetic-tid', cursor);
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.pathname).toBe('/webapp/json/mobile_extra_protocol/getForwardList');
    expect(url.searchParams.get('uin')).toBe(cred.uin);
    expect(url.searchParams.get('unikey')).toBe(
      'http://user.qzone.qq.com/3000000000/mood/synthetic-tid_forward',
    );
    expect(url.searchParams.get('attach_info')).toBe(cursor.attachInfo);
    expect(url.searchParams.has('pos')).toBe(false);
  });
  it('取消后不发请求', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchQzoneForwardPage(cred, '10002', 'post', null, controller.signal),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
