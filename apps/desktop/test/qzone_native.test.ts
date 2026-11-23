import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { databaseRequestSignal } from '@weq/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  ctx: {} as { services?: unknown; account?: unknown },
  imageValid: true,
  pickSaveTarget: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => mocks.ctx }));
vi.mock('@weq/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weq/service')>()),
  getHost: () => ({
    validateImageBuffer: () => mocks.imageValid,
    pickSaveTarget: mocks.pickSaveTarget,
  }),
}));
import { qzoneRouter } from '../src/main/ipc/routers/qzone';
import { pickedBrowserFiles } from '../src/main/browser_files';
import { qzoneMediaSource, mergeQzonePosts } from '../src/renderer/src/lib/qzone';
import { QZONE_VISIBILITY } from '../src/shared/qzone';
const selfUin = '10001',
  hostUin = '10002';
const query = { selfUin, hostUin, requestId: '11111111-1111-4111-8111-111111111111', offset: 0 };
let services: {
  accountConfig: { getRecord: ReturnType<typeof vi.fn> };
  webQuery: Record<string, ReturnType<typeof vi.fn>>;
  profile?: { nicksByUins: ReturnType<typeof vi.fn> };
};
const api = qzoneRouter.createCaller({});
beforeEach(() => {
  services = {
    accountConfig: { getRecord: vi.fn(() => ({ qqOnline: true, qqPid: 1, configId: 'live' })) },
    webQuery: {
      getQzoneMsgList: vi.fn(async () => ({
        total: 1,
        list: [
          { tid: 'synthetic_tid', content: 'fixture', nativeMedia: { voice: ['private-wire'] } },
        ],
      })),
      getQzoneFeeds: vi.fn(async () => ({ feeds: [], hasMore: false })),
      getQzonePostDetail: vi.fn(async () => ({ content: 'full', contentComplete: true })),
      getQzonePostImages: vi.fn(async () => ['https://a.qpic.cn/full']),
      getQzoneMediaTypes: vi.fn(async () => [{ videoId: 'fixture', isLivePhoto: true }]),
      getQzoneNativeDetail: vi.fn(async () => ({
        mediaTypes: [],
        upvote: {
          count: 199,
          upvoted: false,
          users: [{ uin: '10003', uid: '', nickname: '合成' }],
        },
      })),
      getQzoneForwardPage: vi.fn(async () => ({
        forwards: [],
        reportedTotal: 0,
        rawCount: 0,
        hasMore: false,
        nextCursor: null,
        stopReason: 'complete',
      })),
      getQzoneStructuredComments: vi.fn(async () => ({
        comments: [],
        likes: [],
        coverage: 'observed',
        commentCountInclusive: 0,
      })),
      getQzoneInteractions: vi.fn(async () => new Map()),
      getQzoneRelated: vi.fn(async () => ({ feeds: [], hasMore: false })),
      getQzoneMemories: vi.fn(async () => ({ feeds: [], hasMore: false })),
      getQzoneAlbumPage: vi.fn(async () => ({
        albums: [],
        total: 0,
        nextOffset: null,
        warning: null,
      })),
      getQzoneSpaceStats: vi.fn(async () => ({
        postCount: 45,
        photoCount: null,
      })),
      publishQzone: vi.fn(async () => ({ tid: 'synthetic_new_tid', time: 1700000000 })),
      readPublishedQzonePost: vi.fn(async () => null),
      uploadQzoneImage: vi.fn(async () => ({
        richval: ',synthetic',
        url: 'signed-source',
        lloc: 'raw',
      })),
    },
  };
  mocks.ctx = { services, account: { context: { uin: selfUin } } };
  mocks.imageValid = true;
  mocks.pickSaveTarget.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe('native Qzone boundary', () => {
  it('空间昵称优先保留在线结果，只批量补齐缺项并绑定数据库取消信号', async () => {
    let remoteSignal: AbortSignal | undefined;
    services.webQuery.getQzoneNicknames = vi.fn(async (_uins: string[], signal: AbortSignal) => {
      remoteSignal = signal;
      return { '10002': '在线昵称' };
    });
    const nicksByUins = vi.fn(async () => {
      expect(databaseRequestSignal()).toBe(remoteSignal);
      return { '10003': '本地昵称' };
    });
    services.profile = { nicksByUins };
    await expect(
      api.people({ selfUin, requestId: query.requestId, uins: ['10002', '10003', '10004'] }),
    ).resolves.toEqual({ '10002': '在线昵称', '10003': '本地昵称' });
    expect(nicksByUins).toHaveBeenCalledOnce();
    expect(nicksByUins).toHaveBeenCalledWith([10003n, 10004n]);
  });

  it('按所选分类导出全部分享并去重，遇到重复页不覆盖已保存文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'weq-shares-test-'));
    try {
      const path = join(directory, 'shares.json');
      mocks.pickSaveTarget.mockResolvedValue({ path, downloadId: null });
      const input = {
        selfUin,
        hostUin,
        requestId: query.requestId,
        expectedAccountConfigId: 'live',
        category: 4 as const,
      };
      const entry = { id: '1', memo: '附言', originalUrl: 'https://example.org/post' };
      const list = vi
        .fn()
        .mockResolvedValueOnce({ items: [entry], next: 2 })
        .mockResolvedValueOnce({ items: [entry, { ...entry, id: '2' }], next: null });
      services.webQuery.qzoneShares = list;
      await expect(api.exportShares(input)).resolves.toEqual({ path, downloadUrl: null, count: 2 });
      expect(list).toHaveBeenNthCalledWith(2, hostUin, 4, 2, expect.any(AbortSignal));
      const saved = await readFile(path, 'utf8');
      expect(JSON.parse(saved)).toMatchObject({
        version: 1,
        hostUin,
        category: 4,
        items: [entry, { id: '2' }],
      });
      list.mockResolvedValue({ items: [{ id: '3' }], next: 2 });
      await expect(api.exportShares(input)).rejects.toThrow('重复返回分享页');
      expect(await readFile(path, 'utf8')).toBe(saved);
      await expect(
        api.exportShares({ ...input, expectedAccountConfigId: 'other' }),
      ).rejects.toThrow('账号数据源已切换');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('推预览准确绑定当前账号和帖，刷新复用详情服务而不返回完整原件', async () => {
    const input = {
      selfUin,
      hostUin,
      tid: 'fixture',
      time: 1700000000,
      requestId: query.requestId,
    };
    expect(await api.upvotes(input)).toEqual({
      count: 199,
      upvoted: false,
      users: [{ uin: '10003', uid: '', nickname: '合成' }],
    });
    expect(services.webQuery.getQzoneNativeDetail).toHaveBeenLastCalledWith(
      hostUin,
      'fixture',
      input.time,
      expect.any(AbortSignal),
      false,
    );
    await api.upvotes({ ...input, refresh: true });
    expect(services.webQuery.getQzoneNativeDetail).toHaveBeenLastCalledWith(
      hostUin,
      'fixture',
      input.time,
      expect.any(AbortSignal),
      true,
    );
    services.webQuery.getQzoneNativeDetail!.mockResolvedValueOnce({ mediaTypes: [] });
    expect(await api.upvotes(input)).toBeNull();
    await expect(api.upvotes({ ...input, time: 0 })).rejects.toThrow();
    await expect(api.upvotes({ ...input, selfUin: '10003' })).rejects.toThrow('账号已切换');
  });
  it('按账号与帖传递不透明转发游标，拒绝无效页指纹', async () => {
    const cursor = { attachInfo: 'opaque,20', previousPageKey: 'a'.repeat(64) };
    const input = { selfUin, hostUin, tid: 'fixture', requestId: query.requestId, cursor };
    await api.forwards(input);
    expect(services.webQuery.getQzoneForwardPage).toHaveBeenCalledWith(
      hostUin,
      'fixture',
      cursor,
      expect.any(AbortSignal),
    );
    await expect(api.forwards({ ...input, selfUin: '10003' })).rejects.toThrow('账号已切换');
    await expect(
      api.forwards({ ...input, cursor: { ...cursor, previousPageKey: 'bad' } }),
    ).rejects.toThrow();
  });
  it('按当前账号与准确帖定位读取原生媒体类型，不替换 Web 列表', async () => {
    const input = {
      selfUin,
      hostUin,
      tid: 'fixture',
      time: 1700000000,
      requestId: query.requestId,
    };
    expect(await api.mediaTypes(input)).toEqual([{ videoId: 'fixture', isLivePhoto: true }]);
    expect(services.webQuery.getQzoneMediaTypes).toHaveBeenCalledWith(
      hostUin,
      'fixture',
      input.time,
      expect.any(AbortSignal),
    );
    expect(services.webQuery.getQzoneMsgList).not.toHaveBeenCalled();
    await expect(api.mediaTypes({ ...input, selfUin: '10003' })).rejects.toThrow('账号已切换');
    await expect(api.mediaTypes({ ...input, time: 0 })).rejects.toThrow();
  });
  it('routes structured reply reads directly without scanning homepage HTML', async () => {
    const input = {
      selfUin,
      hostUin,
      tid: 'post',
      time: 123,
      requestId: query.requestId,
      structuredOnly: true,
    };
    expect(await api.interactions(input)).toMatchObject({ comments: [], commentCountInclusive: 0 });
    expect(services.webQuery.getQzoneStructuredComments).toHaveBeenCalledWith(
      hostUin,
      'post',
      expect.any(AbortSignal),
    );
    expect(services.webQuery.getQzoneInteractions).not.toHaveBeenCalled();
    await expect(api.interactions({ ...input, selfUin: '10003' })).rejects.toThrow('账号已切换');
  });
  it('validates scopes and binds completion, recall and album reads to the account', async () => {
    await api.feeds({ selfUin, requestId: query.requestId, scope: 7 });
    expect(services.webQuery.getQzoneFeeds).toHaveBeenCalledWith(
      selfUin,
      1,
      10,
      expect.any(AbortSignal),
      undefined,
      7,
    );
    const post = { selfUin, hostUin, tid: 'synthetic', requestId: query.requestId };
    await api.detail(post);
    await api.images(post);
    await api.related({ selfUin, requestId: query.requestId, offset: 27 });
    await api.memories({ selfUin, requestId: query.requestId, year: 2020 });
    await api.albumPage({ selfUin, hostUin, requestId: query.requestId, offset: 40 });
    expect(services.webQuery.getQzonePostDetail).toHaveBeenCalledWith(
      hostUin,
      'synthetic',
      expect.any(AbortSignal),
      undefined,
      undefined,
    );
    expect(services.webQuery.getQzonePostImages).toHaveBeenCalledWith(
      hostUin,
      'synthetic',
      expect.any(AbortSignal),
    );
    expect(services.webQuery.getQzoneRelated).toHaveBeenCalledWith(27, expect.any(AbortSignal));
    expect(services.webQuery.getQzoneMemories).toHaveBeenCalledWith(2020, expect.any(AbortSignal));
    await expect(api.detail({ ...post, selfUin: '10003' })).rejects.toThrow('账号已切换');
    await expect(api.memories({ selfUin, requestId: query.requestId, year: 0 })).rejects.toThrow();
  });
  it('reads target-space statistics through the cancellable, account-bound read boundary', async () => {
    expect(await api.stats({ selfUin, hostUin, requestId: query.requestId })).toEqual({
      postCount: 45,
      photoCount: null,
    });
    expect(services.webQuery.getQzoneSpaceStats).toHaveBeenCalledWith(
      hostUin,
      expect.any(AbortSignal),
    );
    await expect(
      api.stats({ selfUin: '10003', hostUin, requestId: query.requestId }),
    ).rejects.toThrow('账号已切换');
    expect(services.webQuery.getQzoneSpaceStats).toHaveBeenCalledTimes(1);
  });
  it('requires the expected current account and online QQ before any request', async () => {
    await expect(api.posts({ ...query, selfUin: '10003' })).rejects.toThrow('账号已切换');
    services.accountConfig.getRecord.mockReturnValue({ qqOnline: false, qqPid: 1 });
    await expect(api.posts(query)).rejects.toThrow('先登录');
    expect(services.webQuery.getQzoneMsgList).not.toHaveBeenCalled();
  });
  it('projects posts without raw media data', async () => {
    expect(await api.posts(query)).toEqual({
      nickname: null,
      total: 1,
      list: [{ tid: 'synthetic_tid', content: 'fixture' }],
    });
    expect(services.webQuery.getQzoneMsgList.mock.calls[0]!.slice(0, 3)).toEqual([hostUin, 0, 20]);
  });
  it('rejects late results from a replaced account session', async () => {
    services.webQuery.getQzoneMsgList.mockImplementation(async () => {
      mocks.ctx.services = {};
      return { total: 0, list: [] };
    });
    await expect(api.posts(query)).rejects.toThrow('账号已切换');
  });
  it('cancels the underlying CGI and cleans up its request identity', async () => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    services.webQuery.getQzoneMsgList.mockImplementation(
      async (_uin, _offset, _size, _capture, signal: AbortSignal) => {
        began();
        return new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      },
    );
    const pending = api.posts(query);
    await started;
    await expect(api.posts(query)).rejects.toThrow('已在运行');
    expect(await api.cancel({ requestId: query.requestId })).toEqual({ cancelled: true });
    await expect(pending).rejects.toThrow('已取消');
    expect(await api.cancel({ requestId: query.requestId })).toEqual({ cancelled: false });
  });
  it('validates identifiers and offsets before reaching web services', async () => {
    await expect(api.posts({ ...query, hostUin: 'javascript:bad' })).rejects.toThrow();
    await expect(api.posts({ ...query, offset: -1 })).rejects.toThrow();
    expect(services.webQuery.getQzoneMsgList).not.toHaveBeenCalled();
  });
  it('publishes only on explicit mutation and forwards visibility unchanged', async () => {
    expect(services.webQuery.publishQzone).not.toHaveBeenCalled();
    expect(
      await api.publish({ selfUin, content: 'fixture', richvals: [], visibility: 64 }),
    ).toEqual({
      tid: 'synthetic_new_tid',
      time: 1700000000,
      post: null,
    });
    expect(services.webQuery.publishQzone).toHaveBeenCalledTimes(1);
    expect(services.webQuery.publishQzone).toHaveBeenCalledWith('fixture', [], 64);
    expect(services.webQuery.readPublishedQzonePost).toHaveBeenCalledWith(
      selfUin,
      'synthetic_new_tid',
      expect.any(Function),
    );
    expect(QZONE_VISIBILITY.find((value) => value.value === 64)?.label).toBe('仅自己可见');
    expect(QZONE_VISIBILITY.find((value) => value.value === 4)?.label).toBe('好友可见');
  });
  it('never automatically replays a failed publisher', async () => {
    services.webQuery.publishQzone.mockRejectedValue(new Error('timeout'));
    await expect(
      api.publish({ selfUin, content: 'fixture', richvals: [], visibility: 1 }),
    ).rejects.toThrow('timeout');
    expect(services.webQuery.publishQzone).toHaveBeenCalledTimes(1);
    expect(services.webQuery.readPublishedQzonePost).not.toHaveBeenCalled();
  });
  it('rejects invalid decoded images and returns no upload URL or raw metadata', async () => {
    mocks.imageValid = false;
    await expect(api.uploadImage({ selfUin, base64: 'YWJj' })).rejects.toThrow('图片');
    expect(services.webQuery.uploadQzoneImage).not.toHaveBeenCalled();
    mocks.imageValid = true;
    mocks.pickSaveTarget.mockReset();
    expect(await api.uploadImage({ selfUin, base64: 'YWJj' })).toEqual({ richval: ',synthetic' });
  });
  it('已暂存的图像交给同一上传接口，传输成功或校验失败都清理暂存', async () => {
    const bytes = Buffer.from('synthetic image');
    for (const valid of [true, false]) {
      const { id } = await pickedBrowserFiles.start(services, bytes.length, 'fixture.jpg');
      await pickedBrowserFiles.append(services, id, 0, bytes);
      const path = pickedBrowserFiles.complete(services, id);
      mocks.imageValid = valid;
      const request = api.uploadImage({ selfUin, expectedAccountConfigId: 'live', uploadId: id });
      if (valid) await expect(request).resolves.toEqual({ richval: ',synthetic' });
      else await expect(request).rejects.toThrow('图片格式无效');
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(services.webQuery.uploadQzoneImage).toHaveBeenCalledOnce();
    expect(services.webQuery.uploadQzoneImage).toHaveBeenCalledWith(
      bytes.toString('base64'),
      expect.any(Function),
    );
  });
});
describe('Qzone media and paging', () => {
  it('rejects script/local URLs, credentials, ports and non-QQ domains', () => {
    for (const value of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://qq.com.evil.test/a',
      'https://user:pass@qpic.cn/a',
      'https://qpic.cn:8080/a',
      '//localhost/private.png',
      '//qpic.cn.evil.test/cover.png',
      '//user:pass@qpic.cn/cover.png',
    ])
      expect(qzoneMediaSource(value)).toBeNull();
    expect(qzoneMediaSource('http://a.qpic.cn/fixture.png')).toBe('http://a.qpic.cn/fixture.png');
    expect(qzoneMediaSource('//mmbiz.qpic.cn/cover.png')).toBe('https://mmbiz.qpic.cn/cover.png');
    expect(qzoneMediaSource('//y.gtimg.cn/music/cover.png')).toBe(
      'https://y.gtimg.cn/music/cover.png',
    );
  });
  it('merges overlapping pages by stable tid, preserving updated rows', () => {
    expect(
      mergeQzonePosts(
        [{ tid: 'a', content: 'old' }],
        [
          { tid: 'a', content: 'new' },
          { tid: 'b', content: 'next' },
        ],
      ),
    ).toEqual([
      { tid: 'a', content: 'new' },
      { tid: 'b', content: 'next' },
    ]);
  });
});
