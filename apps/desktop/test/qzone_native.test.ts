import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  ctx: {} as { services?: unknown; account?: unknown },
  imageValid: true,
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => mocks.ctx }));
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({ isEmpty: () => !mocks.imageValid }) },
}));
import { qzoneRouter } from '../src/main/ipc/routers/qzone';
import { qzoneMediaSource, mergeQzonePosts } from '../src/renderer/src/lib/qzone';
import { QZONE_VISIBILITY } from '../src/shared/qzone';
const selfUin = '10001',
  hostUin = '10002';
const query = { selfUin, hostUin, requestId: '11111111-1111-4111-8111-111111111111', offset: 0 };
let services: {
  accountConfig: { getRecord: ReturnType<typeof vi.fn> };
  webQuery: Record<string, ReturnType<typeof vi.fn>>;
};
const api = qzoneRouter.createCaller({});
beforeEach(() => {
  services = {
    accountConfig: { getRecord: vi.fn(() => ({ qqOnline: true, qqPid: 1 })) },
    webQuery: {
      getQzoneMsgList: vi.fn(async () => ({
        total: 1,
        list: [
          { tid: 'synthetic_tid', content: 'fixture', nativeMedia: { voice: ['private-wire'] } },
        ],
      })),
      getQzoneFeeds: vi.fn(async () => ({ feeds: [], hasMore: false })),
      publishQzone: vi.fn(async () => ({ tid: 'synthetic_new_tid', time: 1700000000 })),
      uploadQzoneImage: vi.fn(async () => ({
        richval: ',synthetic',
        url: 'signed-source',
        lloc: 'raw',
      })),
    },
  };
  mocks.ctx = { services, account: { context: { uin: selfUin } } };
  mocks.imageValid = true;
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe('native Qzone boundary', () => {
  it('requires the expected current account and online QQ before any request', async () => {
    await expect(api.posts({ ...query, selfUin: '10003' })).rejects.toThrow('账号已切换');
    services.accountConfig.getRecord.mockReturnValue({ qqOnline: false, qqPid: 1 });
    await expect(api.posts(query)).rejects.toThrow('先登录');
    expect(services.webQuery.getQzoneMsgList).not.toHaveBeenCalled();
  });
  it('projects posts without raw media data', async () => {
    expect(await api.posts(query)).toEqual({
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
    await api.publish({ selfUin, content: 'fixture', richvals: [], visibility: 64 });
    expect(services.webQuery.publishQzone).toHaveBeenCalledTimes(1);
    expect(services.webQuery.publishQzone).toHaveBeenCalledWith('fixture', [], 64);
    expect(QZONE_VISIBILITY.find((value) => value.value === 64)?.label).toBe('仅自己可见');
    expect(QZONE_VISIBILITY.find((value) => value.value === 4)?.label).toBe('好友可见');
  });
  it('never automatically replays a failed publisher', async () => {
    services.webQuery.publishQzone.mockRejectedValue(new Error('timeout'));
    await expect(
      api.publish({ selfUin, content: 'fixture', richvals: [], visibility: 1 }),
    ).rejects.toThrow('timeout');
    expect(services.webQuery.publishQzone).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid decoded images and returns no upload URL or raw metadata', async () => {
    mocks.imageValid = false;
    await expect(api.uploadImage({ selfUin, base64: 'YWJj' })).rejects.toThrow('图片');
    expect(services.webQuery.uploadQzoneImage).not.toHaveBeenCalled();
    mocks.imageValid = true;
    expect(await api.uploadImage({ selfUin, base64: 'YWJj' })).toEqual({ richval: ',synthetic' });
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
    ])
      expect(qzoneMediaSource(value)).toBeNull();
    expect(qzoneMediaSource('http://a.qpic.cn/fixture.png')).toBe('https://a.qpic.cn/fixture.png');
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
