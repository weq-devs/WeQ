import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createUnreadRefresh,
  createUnreadTargetRefresh,
  createUnreadUpdateGuard,
  retryConversationRead,
  UNREAD_BATCH_SIZE,
  createUnreadRefreshState,
} from '../src/renderer/src/lib/unreadRefresh';

afterEach(() => vi.useRealTimers());

describe('未读刷新调度', () => {
  it('操作回显直接使用小表数量，不再有待精算分支', () => {
    const source = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
    expect(source).not.toContain('countPending');
    expect(source).not.toContain('countCache');
  });
  it('同账号重建保留操作保护，换账号或同号换目录后隔离', () => {
    const state = createUnreadRefreshState();
    const first = state.bind('account:source-a');
    const finish = first.guard.begin(['u_fixture']);
    const same = state.bind('account:source-a');
    expect(same.changed).toBe(false);
    expect(same.guard).toBe(first.guard);
    expect(same.guard.accepts('u_fixture', same.guard.revision())).toBe(false);
    finish();
    const other = state.bind('account:source-b');
    expect(other.changed).toBe(true);
    expect(other.guard).not.toBe(first.guard);
  });
  it('启动批次并行读取并合并为一次回显，不等首屏消息、不逐会话统计', () => {
    const source = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
    const effect = source.slice(
      source.indexOf('const unreadContactsRef'),
      source.indexOf('const unreadDirectoryKey'),
    );
    expect(source).toMatch(/Promise\.all\(\s*batches\.map\(/);
    expect(effect).toContain('await readUnreadInfos({ ...binding, targets })');
    expect(effect).not.toContain('initialized');
    expect(effect).not.toContain('startupTargets');
    expect(effect).toContain('applyLive(rows, startedAt)');
    expect(effect).not.toContain('setInterval');
    expect(effect).not.toContain('while (isCurrent() && initialMessagesPendingRef.current)');
    expect(effect).not.toContain('watermarksOnly');
    expect(effect).toMatch(
      /if \([^)]*changed[^)]*\) \{\s*setReadUndo\(null\);\s*setUnreadByConv\(\{\}\);/,
    );
  });
  it('慢水位轮询执行中不积压重复目标，定向新消息仍可补读一轮', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const target = { chatType: 2, uid: '777' };
    const load = vi.fn(
      (_targets: (typeof target)[]) => new Promise<true>((done) => (release = () => done(true))),
    );
    const sync = createUnreadTargetRefresh(load);
    sync.request([target], false);
    await vi.advanceTimersByTimeAsync(0);
    for (let poll = 0; poll < 20; poll++) sync.request([target], false);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledOnce();
    sync.request([target], false);
    await vi.advanceTimersByTimeAsync(1);
    sync.request([target]);
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(3);
    sync.dispose();
    release();
  });
  it('密集库通知不让同一目标快查超过校准频率，不同目标不受冷却阻塞', async () => {
    vi.useFakeTimers();
    const target = { chatType: 2, uid: '777' };
    const load = vi.fn(async (_targets: (typeof target)[]) => true);
    const sync = createUnreadTargetRefresh(load, undefined, UNREAD_BATCH_SIZE, 1500);
    sync.request([target], false);
    await vi.advanceTimersByTimeAsync(0);
    for (let notice = 0; notice < 10; notice++) {
      sync.request([target], false);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(load).toHaveBeenCalledOnce();
    const other = { chatType: 1, uid: 'u_other' };
    sync.request([other], false);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenLastCalledWith([other]);
    await vi.advanceTimersByTimeAsync(499);
    expect(load).toHaveBeenCalledTimes(3);
    expect(load).toHaveBeenLastCalledWith([target]);
    sync.dispose();
  });
  it('五千会话分批完成，超容量明确请求补扫，不静默丢失', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async (_targets: Array<{ chatType: number; uid: string }>) => true);
    const fallback = vi.fn();
    const queue = createUnreadTargetRefresh(load, fallback);
    const targets = Array.from({ length: 5000 }, (_, i) => ({ chatType: 2, uid: String(i) }));
    queue.request(targets);
    await vi.advanceTimersByTimeAsync(100);
    expect(load.mock.calls.flatMap(([batch]) => batch)).toEqual(targets);
    expect(load.mock.calls.every(([batch]) => batch.length <= 256)).toBe(true);
    queue.request(Array.from({ length: 8193 }, (_, i) => ({ chatType: 2, uid: String(i) })));
    expect(fallback).toHaveBeenCalledOnce();
    queue.dispose();
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
    expect(load.mock.calls[1]![0]).toEqual(targets.slice(256));
    expect(load.mock.calls[2]![0]).toEqual(targets.slice(0, 256));
    live.dispose();
    live.request(targets);
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('坏目标单独退避，新到健康目标不等待它，遗漏目标可作为失败返回', async () => {
    vi.useFakeTimers();
    const bad = { chatType: 2, uid: 'bad' },
      good = { chatType: 1, uid: 'good' };
    const load = vi.fn(async (targets: (typeof bad)[]) =>
      targets.filter((target) => target.uid === 'bad'),
    );
    const queue = createUnreadTargetRefresh(load);
    queue.request([bad]);
    await vi.advanceTimersByTimeAsync(0);
    queue.request([good]);
    await vi.advanceTimersByTimeAsync(1);
    expect(load.mock.calls[1]![0]).toEqual([good]);
    await vi.advanceTimersByTimeAsync(999);
    expect(load.mock.calls[2]![0]).toEqual([bad]);
    queue.dispose();
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
