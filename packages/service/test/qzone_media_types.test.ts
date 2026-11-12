import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetQzoneFeedMediaDetail } from '@weq/protocol';
import { QzoneMediaTypesService } from '../src/account/qzone_media_types';

const target = { ownerUin: '10001', tid: 'post', time: 1700000000 };
const values = [{ videoId: 'fixture', isLivePhoto: true }];
const detail = { mediaTypes: values, content: 'fixture content', commentCount: 3 };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const create = (resolvePid = () => 1) =>
  new QzoneMediaTypesService({ sendPacket: vi.fn() }, resolvePid);
describe('空间媒体按需补全', () => {
  it('相同内容共用在途请求和短期缓存，返回值不可污染缓存', async () => {
    const read = vi.spyOn(GetQzoneFeedMediaDetail, 'invokeDetail').mockResolvedValue(detail);
    const service = create();
    const [a, b] = await Promise.all([service.read(target), service.read(target)]);
    a[0]!.isLivePhoto = false;
    expect(b).toEqual(values);
    expect(await service.read(target)).toEqual(values);
    expect(await service.readDetail(target)).toEqual(detail);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('失败不补造 false，冷却后可以重新读取', async () => {
    vi.useFakeTimers();
    const read = vi
      .spyOn(GetQzoneFeedMediaDetail, 'invokeDetail')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(detail);
    const service = create();
    await expect(service.read(target)).rejects.toThrow('offline');
    await expect(service.read(target)).rejects.toThrow('暂时不可用');
    expect(read).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    expect(await service.read(target)).toEqual(values);
  });
  it('用户手动读取详情刷新缓存，媒体读取仍复用新的结果', async () => {
    const read = vi
      .spyOn(GetQzoneFeedMediaDetail, 'invokeDetail')
      .mockResolvedValueOnce(detail)
      .mockResolvedValue({ ...detail, commentCount: 4 });
    const service = create();
    await service.read(target);
    expect((await service.readDetail(target, undefined, true)).commentCount).toBe(4);
    expect(await service.read(target)).toEqual(values);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('已取消的读取不发包，迟到结果不返回给已取消调用者', async () => {
    let finish!: (v: typeof detail) => void;
    const read = vi.spyOn(GetQzoneFeedMediaDetail, 'invokeDetail').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = create();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(service.read(target, cancelled.signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    const controller = new AbortController();
    const task = service.read(target, controller.signal);
    controller.abort();
    finish(detail);
    await expect(task).rejects.toThrow();
  });
  it('会话 PID 变化不接受旧结果，不同账号实例不共享缓存', async () => {
    let pid = 1;
    vi.spyOn(GetQzoneFeedMediaDetail, 'invokeDetail').mockImplementation(async () => {
      pid = 2;
      return detail;
    });
    await expect(create(() => pid).read(target)).rejects.toThrow('会话已切换');
  });
  it('账号实例独立缓存，成功条目到期后刷新', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(GetQzoneFeedMediaDetail, 'invokeDetail').mockResolvedValue(detail);
    const a = create(),
      b = create();
    await a.read(target);
    await b.read(target);
    expect(read).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5 * 60_000 + 1);
    await a.read(target);
    expect(read).toHaveBeenCalledTimes(3);
  });
  it('缓存有界，超过上限后重新读取最早的条目', async () => {
    const read = vi.spyOn(GetQzoneFeedMediaDetail, 'invokeDetail').mockResolvedValue(detail);
    const service = create();
    for (let i = 0; i < 129; i++) await service.read({ ...target, tid: `post-${i}` });
    await service.read({ ...target, tid: 'post-0' });
    expect(read).toHaveBeenCalledTimes(130);
  });
  it('最多两条不同原生请求在途，不把整页说说同时展开', async () => {
    const finish: (() => void)[] = [];
    vi.spyOn(GetQzoneFeedMediaDetail, 'invokeDetail').mockImplementation(
      () => new Promise((resolve) => finish.push(() => resolve(detail))),
    );
    const service = create();
    const first = service.read(target),
      second = service.read({ ...target, tid: 'two' });
    await expect(service.read({ ...target, tid: 'three' })).rejects.toThrow('正在读取');
    for (const done of finish) done();
    await Promise.all([first, second]);
  });
});
