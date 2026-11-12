import type { AccountSession } from '@weq/account';
import type { UnreadInfoSnapshot, UnreadInfoTarget } from '@weq/db';
import { databaseRequestSignal, withDatabasePriority } from '@weq/db';
import type { QqUnreadSnapshot } from '@weq/native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalUnreadStore } from '../src/account/local_unread';
import { UnreadInfoService } from '../src/account/unread_info';
import {
  createQqUnreadCountSource,
  VERIFIED_QQ_UNREAD_LAYOUT,
  QQ_UNREAD_COVERAGE,
  type UnreadCountSource,
} from '../src/account/unread_count_source';

const target = { chatType: 1, uid: 'u_fixture' };
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function db(latestSeq = '100', msgSeq = 90): UnreadInfoSnapshot {
  return { ...target, peer: '1_u_fixture', latestSeq, msgSeq };
}
function memory(unreadCount = 10, extra: Partial<QqUnreadSnapshot> = {}): QqUnreadSnapshot {
  return {
    success: true,
    code: 'ok',
    message: '',
    rows: [{ ...target, unreadCount }],
    missingTargets: [],
    generation: 'source-1',
    coverage: QQ_UNREAD_COVERAGE,
    layout: VERIFIED_QQ_UNREAD_LAYOUT,
    fromCache: true,
    locateMs: 0,
    elapsedMs: 17,
    ...extra,
  };
}
function fixture() {
  let identity: string | null = 'account-a:pid-1';
  let snapshot = db();
  const read = vi.fn(async () => memory());
  const clear = vi.fn();
  const signals: Array<AbortSignal | undefined> = [];
  const source: UnreadCountSource = { identity: () => identity, read, clear };
  const getUnreadInfos = vi.fn(async (targets: UnreadInfoTarget[], self?: object) => {
    signals.push(databaseRequestSignal());
    return targets.map((t) => ({
      ...snapshot,
      ...t,
      peer: `${t.chatType}_${t.uid}`,
      ...(self ? { outgoingSeqs: [] } : {}),
    }));
  });
  const markRead = vi.fn(async () => true);
  const service = new UnreadInfoService(
    {
      context: { uin: '10001' },
      selfUid: 'u_self',
      msgDbPath: '/synthetic/unread.db',
      unreadInfo: { getUnreadInfos, markRead },
    } as unknown as AccountSession,
    undefined,
    undefined,
    source,
  );
  cleanups.push(() => service.dispose());
  const changed = vi.fn();
  service.onCountsChanged(changed);
  return {
    service,
    source,
    read,
    clear,
    getUnreadInfos,
    changed,
    markRead,
    signals,
    query: (fast = false) => service.getUnreadInfos([target], fast),
    setDb: (row: UnreadInfoSnapshot) => {
      snapshot = row;
    },
    setIdentity: (value: string | null) => {
      identity = value;
    },
  };
}
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('QQ 计数来源与统一未读', () => {
  it('单次页面请求取消不取消账号级后台校准，也不污染下一轮定时刷新', async () => {
    const f = fixture();
    const controller = new AbortController();
    let finish!: (value: QqUnreadSnapshot) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await withDatabasePriority('interactive', () => f.query(), controller.signal);
    controller.abort();
    f.read.mockResolvedValue(memory(7));
    finish(memory(7));
    await settle();
    expect((await f.query())[0]?.unreadCount).toBe(7);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.signals.slice(1).every((signal) => signal && !signal.aborted)).toBe(true);
  });

  it('冷定位不阻塞请求，期间数据库继续刷新，就绪后不用启动差值吞掉新消息', async () => {
    const f = fixture();
    let finish!: (value: QqUnreadSnapshot) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    expect((await f.query())[0]?.unreadCount).toBe(10);
    f.setDb(db('101', 90));
    expect((await f.query())[0]?.unreadCount).toBe(11);
    f.read.mockResolvedValue(memory(11));
    finish(memory(10));
    await settle();
    expect(f.changed).toHaveBeenCalled();
    expect((await f.query(true))[0]?.unreadCount).toBe(11);
    expect((await f.query())[0]?.unreadCount).toBe(11);
    expect(f.getUnreadInfos.mock.calls.at(-1)?.[1]).toBeUndefined();
  });

  it('没有 WeQ 阅读差异时直接采用可信内存计数，不把校准差异全部算作已读', async () => {
    const f = fixture();
    f.read.mockResolvedValue(memory(7));
    await f.query();
    await settle();
    const result = (await f.query(true))[0];
    expect(result?.unreadCount).toBe(7);
    expect(result?.countPending).toBeUndefined();
    expect(result?.readSeq).toBeUndefined();
    f.getUnreadInfos.mockClear();
    expect((await f.query())[0]?.unreadCount).toBe(7);
    expect(f.getUnreadInfos).toHaveBeenCalledTimes(1);
    expect(f.getUnreadInfos.mock.calls[0]?.[1]).toBeUndefined();
  });

  it('自动阅读后按消息边界精确回退，QQ 数字下降、写库或应答不抹除本地阅读', async () => {
    const f = fixture();
    await f.query();
    await settle();
    await f.service.markRead(1, target.uid, '96');
    expect((await f.query())[0]?.unreadCount).toBe(4);
    f.setDb(db('101', 90));
    f.read.mockResolvedValue(memory(11));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.query())[0]?.unreadCount).toBe(5);
    f.setDb(db('100', 93));
    f.read.mockResolvedValue(memory(7));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.query())[0]?.unreadCount).toBe(4);
    f.setDb(db('100', 96));
    f.read.mockResolvedValue(memory(10));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.query())[0]?.unreadCount).toBe(4);
    f.setDb(db('104', 100));
    f.read.mockResolvedValue(memory(4));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.query())[0]?.unreadCount).toBe(4);
  });

  it('QQ 读旧两条并新增两条，计数仍为10也会刷新并显示6，不固定减6', async () => {
    const f = fixture();
    await f.query();
    await settle();
    await f.service.markLocalRead(1, target.uid, '96');
    expect((await f.query())[0]?.unreadCount).toBe(4);
    f.changed.mockClear();
    f.setDb(db('102', 92));
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.changed).toHaveBeenCalled();
    expect((await f.query())[0]?.unreadCount).toBe(6);
    // 再读相同边界不会重复扣减。
    await f.service.markLocalRead(1, target.uid, '96');
    expect((await f.query())[0]?.unreadCount).toBe(6);
  });

  it('缺失目标、失败、未知布局与读取中边界变化均不产生假零或猜差值', async () => {
    const f = fixture();
    await f.query();
    await settle();
    f.read.mockResolvedValue(memory(0, { rows: [], missingTargets: [target] }));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.query())[0]?.unreadCount).toBe(10);
    f.read.mockResolvedValue(memory(0, { success: false }));
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.query())[0]?.unreadCount).toBe(10);
    f.read.mockResolvedValue(memory(0, { layout: 'unknown' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await f.query())[0]?.unreadCount).toBe(10);
    f.read.mockImplementation(async () => {
      f.setDb(db('102', 90));
      return memory(0);
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect((await f.query())[0]?.unreadCount).toBe(0);
    f.read
      .mockImplementationOnce(async () => memory(0))
      .mockImplementationOnce(async () => {
        f.setDb(db('103', 90));
        return memory(0);
      });
    await vi.advanceTimersByTimeAsync(1500);
    expect((await f.query())[0]?.unreadCount).toBe(13);
  });

  it('换来源与关闭时立即放弃缓存，旧请求迟到不发布，清理原生定位', async () => {
    const f = fixture();
    let finish!: (value: QqUnreadSnapshot) => void;
    f.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await f.query();
    f.setIdentity('account-b:pid-2');
    finish(memory(0));
    await settle();
    expect(f.changed).not.toHaveBeenCalled();
    expect((await f.query())[0]?.unreadCount).toBe(10);
    await f.service.dispose();
    expect(f.clear).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.read).toHaveBeenCalledTimes(1);
    expect((await f.query())[0]?.readError).toBe(true);
  });

  it('同 PID 来源 generation 变化时不混用两次快照，后续重新校准', async () => {
    const f = fixture();
    f.read
      .mockResolvedValueOnce(memory(10))
      .mockResolvedValueOnce(memory(0, { generation: 'new' }));
    await f.query();
    await settle();
    expect(f.changed).not.toHaveBeenCalled();
    expect((await f.query())[0]?.unreadCount).toBe(10);
    f.read.mockResolvedValue(memory(3, { generation: 'new' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect((await f.query())[0]?.unreadCount).toBe(3);
  });

  it('省略阅读位置时写库使用同一次捕获的固定位置', async () => {
    const f = fixture();
    await f.service.markRead(1, target.uid);
    expect(f.markRead).toHaveBeenCalledWith(1, target.uid, '100');
  });

  it('旧原生产物不启用读取链路', () => {
    expect(createQqUnreadCountSource({}, '/synthetic/unread.db', () => 1)).toBeUndefined();
  });

  it('正式适配器检查已验证能力，按固定账号路径读取并只清理自己用过的 PID', async () => {
    let pid: number | null = 123;
    const nt = {
      getQqUnreadCapability: () => ({
        supported: true,
        readOnly: true,
        layouts: [VERIFIED_QQ_UNREAD_LAYOUT],
        coverage: QQ_UNREAD_COVERAGE,
      }),
      readQqUnreadCounts: vi.fn(async () => memory()),
      clearQqUnreadCache: vi.fn(() => 1),
    };
    const source = createQqUnreadCountSource(nt, '/synthetic/account-a.db', () => pid);
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      expect(source).toBeUndefined();
      expect(nt.readQqUnreadCounts).not.toHaveBeenCalled();
      return;
    }
    expect(source).toBeDefined();
    expect(source!.identity()).toBe('123:/synthetic/account-a.db');
    await source!.read();
    expect(nt.readQqUnreadCounts).toHaveBeenLastCalledWith({
      pid: 123,
      databasePath: '/synthetic/account-a.db',
      timeoutMs: 60000,
    });
    pid = 124;
    await source!.read();
    expect(nt.clearQqUnreadCache).toHaveBeenCalledWith(123);
    source!.clear();
    expect(nt.clearQqUnreadCache).toHaveBeenLastCalledWith(124);
    pid = null;
    expect(source!.identity()).toBeNull();
    await expect(source!.read()).rejects.toThrow('不可用');
  });
});

describe('阅读范围和历史迁移', () => {
  it.each([false, true])('自动／手动阅读按同一固定边界去重，manual=%s', (manual) => {
    const store = new LocalUnreadStore();
    const before = store.resolve(db('96', 90));
    if (manual) store.setManualRead(before, false);
    else store.markRead(1, target.uid, '96');
    expect(store.resolve(db(), 10).unreadCount).toBe(4);
    expect(store.resolve(db('101'), 11).unreadCount).toBe(5);
    expect(store.resolve(db('100', 93), 7).unreadCount).toBe(4);
    expect(store.resolve(db('102', 92), 10).unreadCount).toBe(6);
    expect(store.resolve(db('104', 100), 4).unreadCount).toBe(4);
  });

  it('操作不把快照之后到达的实时消息吞进已读范围', () => {
    const store = new LocalUnreadStore();
    const captured = store.resolve(db());
    store.recordLive(1, target.uid, '101');
    const operation = store.setManualRead(captured, false);
    expect(operation.applied.latestSeq).toBe('100');
    expect(store.resolve(db('101')).unreadCount).toBe(1);
  });
});
