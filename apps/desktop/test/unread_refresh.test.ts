import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createUnreadRefresh,
  createUnreadTargetRefresh,
  createUnreadUpdateGuard,
  retryConversationRead,
  unreadBadgeTargets,
  UNREAD_COUNT_BATCH_SIZE,
  UNREAD_WATERMARK_BATCH_SIZE,
  createUnreadCountCache,
  createUnreadRefreshState,
} from '../src/renderer/src/lib/unreadRefresh';

afterEach(() => vi.useRealTimers());

describe('未读刷新调度', () => {
  it('手动操作直接回显忽略待确认数量，不将缺少数量和提醒的结果按零应用', () => {
    const source = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
    const apply = source.slice(
      source.indexOf('const applyUnreadRows ='),
      source.indexOf('const markVisibleConversationRead ='),
    );
    expect(apply).toContain('!row.readError && !row.countPending');
    expect(apply).toContain('if (row.readError || row.countPending) continue;');
  });
  it('同账号重建保留操作保护与计数缓存，换账号或同号换目录后隔离', () => {
    const state = createUnreadRefreshState();
    const first = state.bind('["10001","source-a"]');
    expect(first.changed).toBe(true);
    const row = { chatType: 1, uid: 'u_fixture', msgSeq: '1', latestSeq: '10' };
    first.countCache.remember(row, 1, first.guard.revision());
    const finish = first.guard.begin([row.uid]);
    const same = state.bind('["10001","source-a"]');
    expect(same.changed).toBe(false);
    expect(same.guard).toBe(first.guard);
    expect(same.countCache).toBe(first.countCache);
    expect(same.guard.accepts(row.uid, same.guard.revision())).toBe(false);
    finish();
    const other = state.bind('["10001","source-b"]');
    expect(other.changed).toBe(true);
    expect(other.guard).not.toBe(first.guard);
    expect(other.countCache.needsCount(row, 1, other.guard.accepts)).toBe(true);
    expect(state.bind('["10002","source-b"]').changed).toBe(true);
  });
  it('未读读取器仅在账号数据源改变时清空角标，不因 effect 重建无条件清空', () => {
    const source = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
    const effect = source.slice(
      source.indexOf('let scannedDbRevision = -1;'),
      source.indexOf('async function loadUnread()'),
    );
    expect(effect).not.toContain('setReadUndo(null);\n    setUnreadByConv({});');
    expect(effect).toMatch(
      /if \([^)]*changed[^)]*\) \{\s*setReadUndo\(null\);\s*setUnreadByConv\(\{\}\);/,
    );
  });
  it('已完成统计不随无关库写入重算，同水位历史修正低频校准，阅读和水位变化立即校准', () => {
    vi.useFakeTimers();
    const cache = createUnreadCountCache();
    const guard = createUnreadUpdateGuard();
    const row = { chatType: 2, uid: '777', msgSeq: '1', latestSeq: '100' };
    expect(cache.needsCount(row, 1, guard.accepts)).toBe(true);
    cache.remember({ ...row, countPending: true }, 1, guard.revision());
    cache.remember({ ...row, readError: true }, 1, guard.revision());
    expect(cache.needsCount(row, 1, guard.accepts)).toBe(true);
    cache.remember(row, 1, guard.revision());
    for (let poll = 0; poll < 20; poll++) {
      vi.advanceTimersByTime(1500);
      expect(cache.needsCount(row, poll + 1, guard.accepts)).toBe(false);
      expect(cache.needsReconcile(poll + 1)).toBe(false);
    }
    vi.advanceTimersByTime(30000);
    expect(cache.needsCount(row, 2, guard.accepts)).toBe(true);
    // 一次库变化后即使再无通知、也没有红点，周期检查仍能补齐同水位修正。
    expect(cache.needsReconcile(2)).toBe(true);
    expect(cache.needsReconcile(1)).toBe(false);
    expect(cache.needsCount(row, 1, guard.accepts)).toBe(false);
    expect(cache.needsCount({ ...row, msgSeq: '2' }, 1, guard.accepts)).toBe(true);
    expect(cache.needsCount({ ...row, latestSeq: '101' }, 1, guard.accepts)).toBe(true);
    expect(cache.needsCount({ ...row, chatType: 1 }, 1, guard.accepts)).toBe(true);
    guard.begin([row.uid])();
    expect(cache.needsCount(row, 1, guard.accepts)).toBe(true);
    cache.remember(row, 1, guard.revision());
    expect(cache.needsCount(row, 1, guard.accepts)).toBe(false);
  });
  it('五千会话稳定水位只快查，不随其它会话持续写库反复补算', () => {
    vi.useFakeTimers();
    const cache = createUnreadCountCache();
    const guard = createUnreadUpdateGuard();
    const rows = Array.from({ length: 5000 }, (_, index) => ({
      chatType: 2,
      uid: String(index),
      msgSeq: '1',
      latestSeq: '100',
      unreadCount: 0,
    }));
    for (const row of rows) cache.remember(row, 1, guard.revision());
    expect(Math.ceil(rows.length / UNREAD_WATERMARK_BATCH_SIZE)).toBe(20);
    for (let pass = 0; pass < 3; pass++) {
      vi.advanceTimersByTime(15000);
      expect(rows.filter((row) => cache.needsCount(row, pass + 2, guard.accepts))).toEqual([]);
    }
    const changed = { ...rows[100]!, latestSeq: '101' };
    expect(cache.needsCount(changed, 4, guard.accepts)).toBe(true);
    vi.advanceTimersByTime(15000);
    expect(rows.filter((row) => cache.needsCount(row, 4, guard.accepts))).toHaveLength(5000);
  });
  it('水位相同但提醒变化时不复用旧统计，失败不延长校准期限', () => {
    vi.useFakeTimers();
    const cache = createUnreadCountCache();
    const guard = createUnreadUpdateGuard();
    const row = { chatType: 2, uid: '777', msgSeq: '1', latestSeq: '100' };
    cache.remember(row, 1, guard.revision());
    const highlighted = { ...row, highlights: [{ msgSeq: 90, text: 'reminder' }] };
    expect(cache.needsCount(highlighted, 1, guard.accepts)).toBe(true);
    cache.remember(highlighted, 1, guard.revision());
    expect(cache.needsCount({ ...highlighted }, 2, guard.accepts)).toBe(false);
    expect(cache.needsCount(row, 2, guard.accepts)).toBe(true);
    vi.advanceTimersByTime(59000);
    cache.remember({ ...highlighted, readError: true }, 2, guard.revision());
    vi.advanceTimersByTime(1000);
    expect(cache.needsCount(highlighted, 2, guard.accepts)).toBe(true);
  });
  it('移出目录的旧会话不让到期检查持续触发空校准', () => {
    vi.useFakeTimers();
    const cache = createUnreadCountCache();
    const guard = createUnreadUpdateGuard();
    const row = { chatType: 2, uid: '777', msgSeq: '1', latestSeq: '100' };
    cache.remember(row, 1, guard.revision());
    vi.advanceTimersByTime(60000);
    expect(cache.needsReconcile(2)).toBe(true);
    cache.retain([{ chatType: 1, uid: '777' }]);
    expect(cache.needsReconcile(2)).toBe(false);
    expect(cache.needsCount(row, 1, guard.accepts)).toBe(true);
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
    const sync = createUnreadTargetRefresh(load, undefined, UNREAD_WATERMARK_BATCH_SIZE, 1500);
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
  it('精确统计使用小批次，逐批交付且不改变水位快查的批次上限', async () => {
    vi.useFakeTimers();
    const targets = Array.from({ length: UNREAD_COUNT_BATCH_SIZE * 2 + 1 }, (_, index) => ({
      chatType: 2,
      uid: String(index),
    }));
    const load = vi.fn(async (_batch: typeof targets) => true);
    const count = createUnreadTargetRefresh(load, undefined, UNREAD_COUNT_BATCH_SIZE);
    count.request(targets);
    await vi.advanceTimersByTimeAsync(100);
    expect(load.mock.calls.map(([batch]) => batch.length)).toEqual([
      UNREAD_COUNT_BATCH_SIZE,
      UNREAD_COUNT_BATCH_SIZE,
      1,
    ]);
    expect(load.mock.calls.flatMap(([batch]) => batch)).toEqual(targets);
    count.dispose();
    const fast = createUnreadTargetRefresh(load);
    load.mockClear();
    fast.request(targets);
    await vi.advanceTimersByTimeAsync(100);
    expect(load).toHaveBeenCalledOnce();
    fast.dispose();
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
    const scan = source.slice(
      source.indexOf('async function loadUnread()'),
      source.indexOf('const refresh = createUnreadRefresh(loadUnread)'),
    );
    expect(scan).toContain('const batchSize = UNREAD_WATERMARK_BATCH_SIZE');
    expect(scan).toContain('readTargets(targets.slice(index, index + batchSize), true)');
    expect(scan).not.toContain('getUnreadInfos.query');
    expect(source).toContain('countCache.needsReconcile(dbRevisionRef.current)');
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
