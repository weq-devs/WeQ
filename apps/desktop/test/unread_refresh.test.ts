import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUnreadRefresh, retryConversationRead } from '../src/renderer/src/lib/unreadRefresh';

afterEach(() => vi.useRealTimers());

describe('未读刷新调度', () => {
  it('已读失败有限重试，切走后停止，成功的幂等结果不重试', async () => {
    vi.useFakeTimers();
    let current = true;
    const write = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('锁库'))
      .mockResolvedValue(false);
    const pending = retryConversationRead(write, () => current);
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toBe(false);
    expect(write).toHaveBeenCalledTimes(2);
    write.mockRejectedValueOnce(new Error('锁库'));
    const cancelled = retryConversationRead(write, () => current);
    current = false;
    await vi.advanceTimersByTimeAsync(150);
    expect(await cancelled).toBeNull();
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('已读重试耗尽后把失败交还调用方', async () => {
    vi.useFakeTimers();
    const write = vi.fn(async () => {
      throw new Error('锁库');
    });
    const result = expect(retryConversationRead(write, () => true)).rejects.toThrow('锁库');
    await vi.advanceTimersByTimeAsync(600);
    await result;
    expect(write).toHaveBeenCalledTimes(3);
  });

  it('持续通知不推迟首轮，执行中不并发，只补一轮', async () => {
    vi.useFakeTimers();
    let release: ((ok: boolean) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const refresh = createUnreadRefresh(load);
    refresh.request();
    await vi.advanceTimersByTimeAsync(50);
    refresh.request();
    await vi.advanceTimersByTimeAsync(50);
    expect(load).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) refresh.request();
    await vi.advanceTimersByTimeAsync(500);
    expect(load).toHaveBeenCalledTimes(1);
    release!(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(2);
    refresh.dispose();
    release!(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('失败自动退避重试，数据库通知不绕过退避，成功后恢复快速刷新', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('暂时锁库'))
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const refresh = createUnreadRefresh(load);
    refresh.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(1);
    refresh.request();
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(load).toHaveBeenCalledTimes(3);
    refresh.request();
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledTimes(4);
    refresh.dispose();
  });

  it('销毁后取消待执行查询，忽略后续请求', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => true);
    const refresh = createUnreadRefresh(load);
    refresh.request();
    refresh.dispose();
    refresh.request();
    await vi.advanceTimersByTimeAsync(10000);
    expect(load).not.toHaveBeenCalled();
  });
});
