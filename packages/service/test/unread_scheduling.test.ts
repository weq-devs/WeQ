import type { AccountSession } from '@weq/account';
import type { UnreadInfoSnapshot, UnreadReadChange } from '@weq/db';
import { databaseRequestSignal, withDatabasePriority } from '@weq/db';
import { afterEach, expect, it, vi } from 'vitest';
import { UnreadInfoService } from '../src/account/unread_info';

const services: UnreadInfoService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose();
  vi.useRealTimers();
});
const target = { chatType: 2, uid: '70001' };
const row = (extra: Partial<UnreadInfoSnapshot> = {}): UnreadInfoSnapshot => ({
  ...target,
  peer: '2_70001',
  msgSeq: 90,
  latestSeq: '100',
  ...extra,
});
function fixture(readOnly = false) {
  let rows = [row()];
  let original = row();
  const signals: Array<AbortSignal | undefined> = [];
  const all = vi.fn(async () => {
    signals.push(databaseRequestSignal());
    return rows.map((r) => ({ ...r }));
  });
  const setReadState = vi.fn(
    async (
      chatType: number,
      uid: string,
      readSeq: string,
      _through: string,
      unread: boolean,
    ): Promise<UnreadReadChange> => {
      original = rows[0]!;
      rows = rows.map((r) =>
        r.uid !== uid
          ? r
          : { ...r, msgSeq: unread ? r.msgSeq : Number(readSeq), markUnread: unread },
      );
      return {
        chatType,
        uid,
        existed: true,
        before: new Uint8Array([1]),
        after: new Uint8Array([2]),
        afterReadSeq: readSeq,
      };
    },
  );
  const undoReadState = vi.fn(async () => {
    rows = [{ ...rows[0]!, msgSeq: original.msgSeq, markUnread: original.markUnread }];
    return true;
  });
  const markRead = vi.fn(async (_chatType: number, _uid: string, sequence: string) => {
    rows = [{ ...rows[0]!, msgSeq: Number(sequence), markUnread: false }];
    return true;
  });
  const session = {
    context: { uin: '10001' },
    selfUid: 'u_self',
    msgDbPath: '/synthetic/small-unread.db',
    unreadInfo: {
      getAllUnreadInfos: all,
      getUnreadInfos: vi.fn(),
      setReadState,
      undoReadState,
      markRead,
    },
  } as unknown as AccountSession;
  const service = new UnreadInfoService(
    session,
    undefined,
    readOnly ? { statePath: '', readOnly: true } : undefined,
  );
  services.push(service);
  return {
    service,
    all,
    signals,
    setReadState,
    markRead,
    undoReadState,
    query: (fast = false) => service.getUnreadInfos([target], fast),
    update: (next: UnreadInfoSnapshot[]) => {
      rows = next;
      service.invalidate();
    },
  };
}

it('不同批次和兼容轻量请求共用初始化快照，后续读取不发 SQL', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.query(), f.query(true)]);
  expect(a).toEqual(b);
  expect(a[0]?.unreadCount).toBe(10);
  for (let i = 0; i < 20; i++) expect((await f.query())[0]).toBe(a[0]);
  expect(f.all).toHaveBeenCalledOnce();
});
it('共享初始化不继承单个页面取消，账号关闭才取消底层读取', async () => {
  const f = fixture();
  await f.query();
  const controller = new AbortController();
  controller.abort();
  expect(
    (await withDatabasePriority('interactive', () => f.query(), controller.signal))[0]?.unreadCount,
  ).toBe(10);
  expect(f.signals.every((signal) => signal && !signal.aborted)).toBe(true);
  await f.service.dispose();
  expect((await f.query())[0]?.readError).toBe(true);
});
it('数据库读取失败或单行损坏保留已有角标，不交付假零；恢复后直接采用新值', async () => {
  const f = fixture();
  await f.query();
  f.update([row({ readError: true })]);
  expect((await f.query())[0]?.unreadCount).toBe(10);
  f.all.mockRejectedValueOnce(new Error('busy'));
  f.service.invalidate();
  expect((await f.query())[0]?.unreadCount).toBe(10);
  f.update([row({ latestSeq: '102' })]);
  expect((await f.query())[0]?.unreadCount).toBe(12);
});
it('首次失败返回 readError，不把未获得的计数按零发布；后续可以恢复', async () => {
  const f = fixture();
  await f.query();
  f.all.mockRejectedValueOnce(new Error('busy'));
  const absent = { chatType: 1, uid: 'missing' };
  expect((await f.service.getUnreadInfos([absent]))[0]).toMatchObject({ readError: true });
  f.update([row({ ...absent, peer: '1_missing' })]);
  expect((await f.service.getUnreadInfos([absent]))[0]?.unreadCount).toBe(10);
});
it('订阅者共享 1.5 秒补查，纯阅读变化通知；最后一个退出后停止', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  const a = vi.fn(),
    b = vi.fn(),
    stopA = f.service.onCountsChanged(a),
    stopB = f.service.onCountsChanged(b);
  await vi.advanceTimersByTimeAsync(50);
  f.all.mockClear();
  f.update([row({ msgSeq: 95 })]);
  await vi.advanceTimersByTimeAsync(50);
  expect(a).toHaveBeenCalledWith([expect.objectContaining(target)]);
  expect(b).toHaveBeenCalledWith([expect.objectContaining(target)]);
  expect((await f.query())[0]?.unreadCount).toBe(5);
  f.all.mockClear();
  stopA();
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.all).toHaveBeenCalledOnce();
  f.all.mockClear();
  stopB();
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.all).not.toHaveBeenCalled();
});
it('密集文件通知只合并小表读取，未变会话不发布，变化会话单独通知', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  const changed = vi.fn();
  f.service.onCountsChanged(changed);
  await vi.advanceTimersByTimeAsync(50);
  changed.mockClear();
  f.all.mockClear();
  for (let i = 0; i < 100; i++) f.service.invalidate();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.all).toHaveBeenCalledOnce();
  expect(changed).not.toHaveBeenCalled();
  f.update([row({ decreasedSeqs: ['99'] })]);
  await vi.advanceTimersByTimeAsync(50);
  expect(changed).toHaveBeenCalledOnce();
  expect((await f.query())[0]?.unreadCount).toBe(9);
});
it('只读账号阅读和撤销不写 QQ，后来的新消息仍显示', async () => {
  const f = fixture(true);
  await f.query();
  const change = await f.service.setReadState([target], false);
  expect(change.rows[0]?.unreadCount).toBe(0);
  f.update([row({ latestSeq: '102' })]);
  expect((await f.query())[0]?.unreadCount).toBe(2);
  expect((await f.service.undoReadState(change.undoToken)).rows[0]?.unreadCount).toBe(12);
  expect(f.setReadState).not.toHaveBeenCalled();
});
it('手动已读、未读和撤销均只操作字段，不降低阅读水位制造历史未读', async () => {
  const f = fixture();
  const read = await f.service.setReadState([target, target], false);
  expect(read.rows[0]?.unreadCount).toBe(0);
  expect(f.setReadState).toHaveBeenCalledTimes(1);
  expect((await f.service.undoReadState(read.undoToken)).rows[0]?.unreadCount).toBe(10);
  const unread = await f.service.setReadState([target], true);
  expect(f.setReadState).toHaveBeenLastCalledWith(2, '70001', '90', '100', true);
  expect(unread.rows[0]?.unreadCount).toBe(10);
});
it('写库失败仍即时保存阅读结果，自动重试失败操作且新操作取代旧重试', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  f.setReadState.mockRejectedValueOnce(new Error('busy'));
  const result = await f.service.setReadState([target], false);
  expect(result.rows[0]?.unreadCount).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.setReadState).toHaveBeenCalledTimes(2);
  f.setReadState.mockRejectedValueOnce(new Error('busy'));
  await f.service.setReadState([target], true);
  await f.service.markRead(2, '70001', '100');
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.setReadState).toHaveBeenCalledTimes(3);
});
it('自动阅读失败保留本地结果，并按固定位置重试，不追随新消息', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  f.markRead.mockRejectedValueOnce(new Error('busy'));
  expect(await f.service.markRead(2, '70001', '100')).toBe(true);
  f.update([row({ latestSeq: '102' })]);
  expect((await f.query())[0]?.unreadCount).toBe(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.setReadState).toHaveBeenLastCalledWith(2, '70001', '100', '100', false);
});
it('1300 会话一次加载，查询接口不逐会话统计', async () => {
  const f = fixture();
  await f.query();
  const rows = Array.from({ length: 1300 }, (_, i) => row({ uid: String(i), peer: `2_${i}` }));
  f.update(rows);
  f.all.mockClear();
  const result = await f.service.getUnreadInfos(rows);
  expect(result).toHaveLength(1300);
  expect(result.every((r) => r.unreadCount === 10)).toBe(true);
  expect(f.all).toHaveBeenCalledOnce();
});

it('小表确认缺行后缓存空快照，目录缺行不导致每次读取都重查', async () => {
  const f = fixture();
  await f.query();
  const absent = { chatType: 2, uid: 'not-in-either-table' };
  expect((await f.service.getUnreadInfos([absent]))[0]).toMatchObject({ unreadCount: 0 });
  f.all.mockClear();
  for (let i = 0; i < 50; i++) await f.service.getUnreadInfos([absent, target], i % 2 === 0);
  expect(f.all).not.toHaveBeenCalled();
});

it('同会话旧写入执行中收到新操作时串行写入，不让迟到已读覆盖新未读', async () => {
  const f = fixture();
  await f.query();
  const original = f.setReadState.getMockImplementation()!;
  let release!: () => void;
  f.setReadState.mockImplementationOnce(async (...args) => {
    await new Promise<void>((done) => {
      release = done;
    });
    return original(...args);
  });
  const old = f.service.setReadState([target], false);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const next = f.service.setReadState([target], true);
  await new Promise<void>((done) => setTimeout(done, 10));
  expect(f.setReadState).toHaveBeenCalledOnce();
  release();
  await Promise.all([old, next]);
  expect(f.setReadState).toHaveBeenLastCalledWith(2, '70001', '100', '100', true);
  expect((await f.query())[0]?.unreadCount).toBe(1);
});

it('撤销写库暂时失败自动重试原撤销，不用普通已读写入冒充降低水位', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const change = await f.service.setReadState([target], false);
  f.undoReadState.mockRejectedValueOnce(new Error('busy'));
  expect((await f.service.undoReadState(change.undoToken)).restored).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.undoReadState).toHaveBeenCalledTimes(2);
  expect((await f.query())[0]?.unreadCount).toBe(10);
});
