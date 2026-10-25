import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createUnreadRefresh,
  createUnreadTargetRefresh,
  createUnreadUpdateGuard,
  retryConversationRead,
  unreadBadgeTargets,
} from '../src/renderer/src/lib/unreadRefresh';

afterEach(() => vi.useRealTimers());

describe('未读刷新调度', () => {
  it('QQ 仅推进已读水位时优先校准现有红点，不等待全量扫描或新消息', async () => {
    vi.useFakeTimers();
    const background = createUnreadRefresh(() => new Promise<boolean>(() => {}));
    background.request();
    await vi.advanceTimersByTimeAsync(100);
    const contacts = [
      { chatType: 1, targetUid: 'u_friend' },
      { chatType: 2, targetUid: '777' },
      { chatType: 2, targetUid: '888' },
      { chatType: 8, targetUid: 'device' },
      { chatType: 999, targetUid: 'unsupported' },
    ];
    const counts: Record<string, number> = { u_friend: 3, device: 1, unsupported: 1 };
    const highlights = { '777': [{}] };
    const load = vi.fn(async (targets: Array<{ chatType: number; uid: string }>) => {
      for (const target of targets) counts[target.uid] = 0;
      return true;
    });
    const live = createUnreadTargetRefresh(load);
    live.request(unreadBadgeTargets(contacts, counts, highlights));
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledWith([
      { chatType: 1, uid: 'u_friend' },
      { chatType: 2, uid: '777' },
      { chatType: 8, uid: 'device' },
    ]);
    expect(counts.u_friend).toBe(0);
    expect(counts.device).toBe(0);
    expect(unreadBadgeTargets(contacts, counts, {})).toEqual([]);
    live.dispose();
    background.dispose();
  });

  it('数据库通知与焦点恢复同时触发红点快速校准，卸载清理入口', () => {
    const source = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
    expect(source.includes('requestUnreadReadSyncRef.current?.();\n  }, [unreadRevision]);')).toBe(
      true,
    );
    expect(/const onVisible = \(\) => \{.*?requestReadSync\(\);/s.test(source)).toBe(true);
    expect(source.includes('requestUnreadReadSyncRef.current = null;')).toBe(true);
  });

  it('实时目标独立于慢速全量扫描刷新，合并去重且执行中收到的事件不丢失', async () => {
    vi.useFakeTimers();
    const backgroundLoad = vi.fn(() => new Promise<boolean>(() => {}));
    const background = createUnreadRefresh(backgroundLoad);
    background.request();
    await vi.advanceTimersByTimeAsync(100);
    let release: (ok: boolean) => void = () => {};
    const load = vi.fn(
      (_targets: Array<{ chatType: number; uid: string }>) =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const live = createUnreadTargetRefresh(load);
    const target = { chatType: 2, uid: '777' };
    live.request([target, target]);
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith([target]);
    live.request([target, { chatType: 1, uid: 'u_other' }]);
    release(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenLastCalledWith([target, { chatType: 1, uid: 'u_other' }]);
    expect(load).toHaveBeenCalledTimes(2);
    live.dispose();
    background.dispose();
    release(true);
  });

  it('实时读取失败自动保留目标重试，分批不超过 IPC 上限，销毁后停止', async () => {
    vi.useFakeTimers();
    const load = vi
      .fn(async (_targets: Array<{ chatType: number; uid: string }>) => true)
      .mockRejectedValueOnce(new Error('锁库'));
    const live = createUnreadTargetRefresh(load);
    const targets = Array.from({ length: 257 }, (_, i) => ({ chatType: 2, uid: String(i) }));
    live.request(targets);
    await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls[0]![0]).toEqual(targets.slice(0, 256));
    await vi.advanceTimersByTimeAsync(1001);
    expect(load.mock.calls.slice(1).flatMap(([batch]) => batch)).toEqual(targets);
    live.dispose();
    live.request(targets);
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('当前会话直接更新，旧扫描及写入期间的扫描不能覆盖，无关会话仍刷新', () => {
    const guard = createUnreadUpdateGuard();
    const before = guard.revision();
    const finish = guard.begin(['u_one']);
    const during = guard.revision();
    expect(guard.accepts('u_one', before)).toBe(false);
    expect(guard.accepts('u_one', during)).toBe(false);
    expect(guard.accepts('u_other', before)).toBe(true);
    finish();
    expect(guard.accepts('u_one', during)).toBe(false);
    expect(guard.accepts('u_one', guard.revision())).toBe(true);
  });

  it('实时未读先回显后旧全量扫描不能清掉红点，后续已读仍优先', () => {
    const guard = createUnreadUpdateGuard();
    const scan = guard.revision();
    const live = guard.revision();
    expect(guard.accepts('u_new', live)).toBe(true);
    guard.begin(['u_new'])();
    expect(guard.accepts('u_new', scan)).toBe(false);
    expect(guard.accepts('u_other', scan)).toBe(true);
    const nextLive = guard.revision();
    const read = guard.begin(['u_new']);
    expect(guard.accepts('u_new', nextLive)).toBe(false);
    read();
    expect(guard.accepts('u_new', nextLive)).toBe(false);
  });

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
