import { afterEach, expect, it, vi } from 'vitest';
import { getGroupAlbumFeed, parseGroupAlbumFeed } from '../src/account/web/group_album_feed';
import { WebAuthError, WebCredentialProvider, computeBkn } from '../src/account/web/credential';
import { WebQueryService } from '../src/account/web';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const request = { groupCode: '123456', albumId: 'synthetic_album', batchId: '1700000000' };
function response() {
  return {
    ret: 0,
    data: {
      hasmore: 0,
      attach_info: '',
      detail_data: {
        singledetail: {
          '0': { time: 1700000000 },
          '1': { user: { uin: '10001', nickname: '合成作者' } },
          '2': { subid: '1700000000' },
          '5': {
            qunid: '123456',
            albumid: 'synthetic_album',
            albumname: '合成相册',
            uploadnum: 2,
            picdata: [
              {
                lloc: 'synthetic_image',
                photourl: {
                  '1': {
                    url: 'https://qungz.photo.store.qq.com/synthetic/image',
                    width: 800,
                    height: 600,
                  },
                },
              },
              {
                lloc: 'synthetic_video',
                videoflag: 1,
                photourl: { '11': { url: 'https://qungz.photo.store.qq.com/synthetic/cover' } },
                videodata: { videourl: 'https://video.qq.com/synthetic.mp4' },
              },
            ],
          },
          '10': {
            num: 1,
            commments: [
              {
                commentid: 'synthetic_comment',
                content: '合成评论',
                date: 1700000001,
                user: { uin: '10002', nickname: '合成评论者' },
                replynum: 1,
                replys: [
                  {
                    replyid: 'synthetic_reply',
                    content: '合成回复',
                    date: 1700000002,
                    user: { uin: '10003', nickname: '合成回复者' },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}
it('按官方 cell 槽位读取真实身份、图片／视频、评论及回复，不依赖标题猜目标', () => {
  const page = parseGroupAlbumFeed(response(), request);
  expect(page).toMatchObject({
    ...request,
    albumName: '合成相册',
    author: { uin: '10001', name: '合成作者' },
    totalComments: 1,
    totalMedia: 2,
    hasMore: false,
    nextCursor: null,
  });
  expect(page.media.map((row) => [row.id, row.kind, row.url])).toEqual([
    ['synthetic_image', 'image', 'https://qungz.photo.store.qq.com/synthetic/image'],
    ['synthetic_video', 'video', 'https://video.qq.com/synthetic.mp4'],
  ]);
  expect(page.comments[0]).toMatchObject({
    id: 'synthetic_comment',
    content: '合成评论',
    replies: [{ id: 'synthetic_reply', content: '合成回复' }],
  });
});
it.each(['qunid', 'albumid'] as const)('错%s不能把别的群或相册显示在目标中', (field) => {
  const raw = response();
  raw.data.detail_data.singledetail['5'][field] = 'wrong';
  expect(() => parseGroupAlbumFeed(raw, request)).toThrow('不一致');
});
it('错批次、缺详情、缺业务码、认证拒绝分别报告，不误报空内容', () => {
  const raw = response();
  raw.data.detail_data.singledetail['2'].subid = '1700000001';
  expect(() => parseGroupAlbumFeed(raw, request)).toThrow('不一致');
  expect(() => parseGroupAlbumFeed({ ret: 0, data: {} }, request)).toThrow('未返回详情');
  expect(() => parseGroupAlbumFeed({ data: {} }, request)).toThrow('业务回执');
  expect(() => parseGroupAlbumFeed({ ret: -3000 }, request)).toThrow(WebAuthError);
  expect(() => parseGroupAlbumFeed({ ret: -1 }, request)).toThrow('code=-1');
});

it('旧定位视图使用服务端明确的父批次21，且拒绝与请求冲突的父批次', () => {
  const raw = response();
  raw.data.detail_data.singledetail['2'].subid = 'synthetic_view_subid';
  const detail = {
    ...raw,
    data: {
      ...raw.data,
      detail_data: {
        singledetail: {
          ...raw.data.detail_data.singledetail,
          '18': { busi_param: { '21': request.batchId } },
        },
      },
    },
  };
  expect(
    parseGroupAlbumFeed(detail, { ...request, legacyFocus: 'synthetic_focus!' }),
  ).toMatchObject({ batchId: request.batchId });
  detail.data.detail_data.singledetail['18'].busi_param['21'] = '1700000001';
  expect(() => parseGroupAlbumFeed(detail, request)).toThrow('不一致');
});
it('分页必须有前进的游标；缺失数量不伪造零', () => {
  const raw = response();
  raw.data.hasmore = 1;
  expect(() => parseGroupAlbumFeed(raw, request)).toThrow('分页');
  raw.data.attach_info = 'next';
  expect(parseGroupAlbumFeed(raw, request)).toMatchObject({ hasMore: true, nextCursor: 'next' });
  expect(() => parseGroupAlbumFeed(raw, { ...request, cursor: 'next' })).toThrow('分页');
  const empty = response();
  Object.assign(empty.data.detail_data.singledetail['10'], {
    num: undefined,
    commments: undefined,
  });
  expect(parseGroupAlbumFeed(empty, request)).toMatchObject({ totalComments: null, comments: [] });
});

it('单独返回的主评论不丢失或重复，空占位不冒充真实评论', () => {
  const raw = response(),
    discussion = raw.data.detail_data.singledetail['10'];
  const main = { ...discussion.commments[0]!, commentid: 'synthetic_main', content: '主评论' };
  Object.assign(discussion, { main_comment: main });
  expect(parseGroupAlbumFeed(raw, request).comments.map((row) => row.id)).toEqual([
    'synthetic_main',
    'synthetic_comment',
  ]);
  Object.assign(discussion, { main_comment: discussion.commments[0] });
  expect(parseGroupAlbumFeed(raw, request).comments).toHaveLength(1);
  Object.assign(discussion, { main_comment: { commentid: 0 } });
  expect(parseGroupAlbumFeed(raw, request).comments).toHaveLength(1);
});
it('重复媒体、未知视频类型与损坏评论明确失败，不悄悄显示错误类型或空内容', () => {
  const duplicate = response();
  duplicate.data.detail_data.singledetail['5'].picdata[1]!.lloc = 'synthetic_image';
  expect(() => parseGroupAlbumFeed(duplicate, request)).toThrow('媒体身份无效');
  const unknown = response();
  Object.assign(unknown.data.detail_data.singledetail['5'].picdata[0]!, { videoflag: 2 });
  expect(() => parseGroupAlbumFeed(unknown, request)).toThrow('媒体类型未知');
  const broken = response();
  Object.assign(broken.data.detail_data.singledetail['10'].commments[0]!, { content: undefined });
  expect(() => parseGroupAlbumFeed(broken, request)).toThrow('评论记录无效');
});
it('GET 使用官方扁平字段及受控旧 URL，保留定位串，不把它猜成评论ID', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(response()), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetcher);
  await getGroupAlbumFeed(
    { uin: '10001', skey: 'synthetic-skey', pskey: 'synthetic-pskey' },
    { ...request, legacyFocus: 'synthetic_focus!', cursor: 'previous' },
  );
  const [value, init] = fetcher.mock.calls[0]!;
  const url = new URL(String(value));
  expect(url.origin + url.pathname).toBe('https://h5.qzone.qq.com/groupphoto/inqq');
  expect(url.searchParams.get('cmd')).toBe('qunGetDetail');
  expect(url.searchParams.get('uin')).toBe('10001');
  expect(url.searchParams.get('g_tk')).toBe(String(computeBkn('synthetic-pskey')));
  expect(url.searchParams.get('refresh_type')).toBe('2');
  expect(url.searchParams.get('attach_info')).toBe('previous');
  const legacy = new URL(url.searchParams.get('mqqinfo.cell_operation.qq_url')!);
  expect(Object.fromEntries(legacy.searchParams)).toEqual({
    i: request.albumId,
    u: request.groupCode,
    p: request.batchId,
    a: '422',
    v: '2',
    cmd: '2',
    f: 'synthetic_focus!',
  });
  expect(init).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
});

it('异步取票期间切换来源，业务读取不发出；取消也不会先取票', async () => {
  let current = true;
  const credential = vi
    .spyOn(WebCredentialProvider.prototype, 'forDomain')
    .mockImplementation(async () => {
      current = false;
      return { uin: '10001', skey: 'synthetic', pskey: 'synthetic' };
    });
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const service = new WebQueryService({} as never, { context: { uin: '10001' } } as never, () => 1);
  const check = () => {
    if (!current) throw Error('synthetic-source-changed');
  };
  await expect(service.getGroupAlbumFeed(request, check)).rejects.toThrow('source-changed');
  expect(fetcher).not.toHaveBeenCalled();
  credential.mockClear();
  current = true;
  const controller = new AbortController();
  controller.abort();
  await expect(service.getGroupAlbumFeed(request, check, controller.signal)).rejects.toThrow();
  expect(credential).not.toHaveBeenCalled();
});
it('认证拒绝后的补取票之前也复核来源，不为旧请求再次取票或读取', async () => {
  let current = true;
  const credential = vi
    .spyOn(WebCredentialProvider.prototype, 'forDomain')
    .mockResolvedValue({ uin: '10001', skey: 'synthetic', pskey: 'synthetic' });
  vi.spyOn(WebCredentialProvider.prototype, 'invalidate').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>(async () => {
    current = false;
    return new Response('{"ret":-3000}', { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  const service = new WebQueryService({} as never, { context: { uin: '10001' } } as never, () => 1);
  await expect(
    service.getGroupAlbumFeed(request, () => {
      if (!current) throw Error('synthetic-source-changed');
    }),
  ).rejects.toThrow('source-changed');
  expect(credential).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
