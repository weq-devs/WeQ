import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const rpc = vi.hoisted(() => ({
  uin: '10001',
  configId: 'source-a',
  online: true,
  feed: vi.fn(),
  albums: vi.fn(),
  media: vi.fn(),
  remember: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: {
      getRecord: () => ({ configId: rpc.configId, uin: rpc.uin, qqOnline: rpc.online, qqPid: 42 }),
    },
    webQuery: { getGroupAlbumFeed: rpc.feed, getGroupAlbumList: rpc.albums },
    groupAlbumMedia: { getMediaList: rpc.media },
    contentSearch: { remember: rpc.remember },
  };
  return {
    getAppContext: () => ({
      account: { context: { uin: rpc.uin } },
      services,
      bootstrap: null,
      platform: null,
    }),
  };
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
  target = { groupCode: '123456', albumId: 'synthetic', batchId: '1700000000' };
beforeEach(() => {
  vi.clearAllMocks();
  rpc.uin = '10001';
  rpc.configId = 'source-a';
  rpc.online = true;
  rpc.feed.mockImplementation(async (request, check) => {
    check();
    return { ...request, comments: [] };
  });
  rpc.albums.mockResolvedValue([]);
  rpc.media.mockResolvedValue({ mediaList: [], nextAttachInfo: '' });
});
it('动态读取使用完整卡片目标和捕获来源，不传绑定字段给 Web 请求', async () => {
  await accountRouter
    .createCaller({})
    .getGroupAlbumFeed({ ...binding, ...target, legacyFocus: 'synthetic_focus!' });
  expect(rpc.feed).toHaveBeenCalledWith(
    { ...target, legacyFocus: 'synthetic_focus!' },
    expect.any(Function),
  );
});
it('缺少账号来源或来自旧来源的请求不发出读取', async () => {
  const api = accountRouter.createCaller({});
  await expect(api.getGroupAlbumFeed(target as never)).rejects.toThrow();
  rpc.configId = 'source-b';
  await expect(api.getGroupAlbumFeed({ ...binding, ...target })).rejects.toThrow('数据源已切换');
  expect(rpc.feed).not.toHaveBeenCalled();
});
it('异步读取期间换同号数据源，旧详情被丢弃', async () => {
  rpc.feed.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return target;
  });
  await expect(
    accountRouter.createCaller({}).getGroupAlbumFeed({ ...binding, ...target }),
  ).rejects.toThrow('数据源已切换');
});
it('异步取票的来源检查阻止旧请求派发', async () => {
  rpc.feed.mockImplementationOnce(async (_request, check) => {
    rpc.uin = '20002';
    check();
    throw Error('不应继续');
  });
  await expect(
    accountRouter.createCaller({}).getGroupAlbumFeed({ ...binding, ...target }),
  ).rejects.toThrow('账号已切换');
});
it('相册列表在返回前复核来源，旧响应不进入搜索索引', async () => {
  rpc.albums.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return [{ id: 'synthetic', title: '旧来源内容' }];
  });
  await expect(
    accountRouter.createCaller({}).listGroupAlbums({ ...binding, groupCode: '123456' }),
  ).rejects.toThrow('数据源已切换');
  expect(rpc.remember).not.toHaveBeenCalled();
});
it('媒体分页每页前后复核，不在换源后继续翻页', async () => {
  rpc.media.mockImplementationOnce(async () => {
    rpc.configId = 'source-b';
    return { mediaList: [], nextAttachInfo: 'next' };
  });
  await expect(
    accountRouter
      .createCaller({})
      .listGroupAlbumMedia({ ...binding, groupCode: '123456', albumId: 'synthetic' }),
  ).rejects.toThrow('数据源已切换');
  expect(rpc.media).toHaveBeenCalledTimes(1);
});
it('QQ 不在线时明确报错，不把读取失败当成空动态', async () => {
  rpc.online = false;
  await expect(
    accountRouter.createCaller({}).getGroupAlbumFeed({ ...binding, ...target }),
  ).rejects.toThrow('登录');
  expect(rpc.feed).not.toHaveBeenCalled();
});
