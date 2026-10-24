import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalUnreadStore } from '../src/account/local_unread';
import { UnreadInfoService } from '../src/account/unread_info';
import type { AccountSession } from '@weq/account';
import type { NewMessages } from '../src/account/nt_msg_hook';
import type { UnreadInfoSnapshot } from '@weq/db';
import { DATALINE_UID_TO_DEVICE, ChatType } from '@weq/codec';
import { SendType } from '@weq/codec/proto/msg/40900';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('未读服务事件与阅读', () => {
  it('设备入站计数，电脑发出和回声不增未读，真实阅读后旧事件不复活', async () => {
    const f = setup();
    const phone = Object.keys(DATALINE_UID_TO_DEVICE).find(
      (uid) => DATALINE_UID_TO_DEVICE[uid] === 'phone',
    )!;
    const pc = Object.keys(DATALINE_UID_TO_DEVICE).find(
      (uid) => DATALINE_UID_TO_DEVICE[uid] === 'pc',
    )!;
    const chatType = ChatType.KCHATTYPEDATALINE;
    const row = {
      chatType,
      uid: phone,
      peer: `${chatType}_${phone}`,
      latestSeq: '9000',
      msgSeq: 9000,
    };
    f.getUnreadInfos.mockResolvedValue([row]);
    await f.query();
    const incoming = {
      ...f.base,
      targetUid: phone,
      senderUid: phone,
      sendType: BigInt(SendType.OTHER_CLIENT),
      chatType,
    };
    f.service.observeNewMessages({
      ...f.change,
      c2c: [],
      dataline: [
        incoming,
        { ...incoming, msgSeq: 9002n, senderUid: pc, sendType: BigInt(SendType.LOCAL) },
      ],
    });
    f.getUnreadInfos.mockResolvedValue([{ ...row, latestSeq: '9002' }]);
    expect((await f.query())[0]?.unreadCount).toBe(1);
    f.service.observeNewMessages({ ...f.change, c2c: [], dataline: [incoming] });
    expect((await f.query())[0]?.unreadCount).toBe(1);
    await f.service.markLocalRead(chatType, phone, '9002');
    f.service.observeNewMessages({ ...f.change, c2c: [], dataline: [incoming] });
    expect((await f.query())[0]?.unreadCount).toBe(0);
  });
  function setup(readOnly = false) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T02:00:00+08:00'));
    const { path } = fixture();
    const getUnreadInfos = vi.fn(async () => [snapshot('9000')]);
    const markRead = vi.fn(async () => false);
    const setReadState = vi.fn(async (chatType: number, uid: string, readSeq: string) => ({
      chatType,
      uid,
      existed: false,
      before: null,
      after: new Uint8Array([1]),
      afterReadSeq: readSeq,
    }));
    const undoReadState = vi.fn(async () => true);
    const session = {
      context: { uin: '10001' },
      selfUid: 'u_self',
      unreadInfo: { getUnreadInfos, markRead, setReadState, undoReadState },
    } as unknown as AccountSession;
    const service = new UnreadInfoService(session, undefined, { statePath: path, readOnly });
    const query = () => service.getUnreadInfos([{ chatType: 1, uid: 'u_fixture' }]);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const base = {
      msgId: 1n,
      msgSeq: 9001n,
      targetUid: 'u_fixture',
      targetUin: 10002n,
      senderUid: 'u_fixture',
      senderUin: 10002n,
      sendTime: now,
      elements: [],
    };
    const change: NewMessages = {
      file: {
        dbPath: '/fixture/nt_msg.db',
        prevTotal: 0,
        total: 1,
        delta: 1,
        files: [],
        at: Date.now(),
      },
      c2c: [base],
      group: [],
    };
    return {
      service,
      query,
      change,
      base,
      path,
      markRead,
      getUnreadInfos,
      session,
      now,
      setReadState,
      undoReadState,
    };
  }

  it('旧消息导入、自己发送、未来时间不计数；真实新消息重复推送只记一次', async () => {
    const f = setup();
    await f.query();
    f.service.observeNewMessages({
      ...f.change,
      c2c: [
        { ...f.base, msgSeq: 8999n, sendTime: f.now - 3600n },
        { ...f.base, senderUid: 'u_self' },
        { ...f.base, sendTime: f.now + 3600n },
      ],
    });
    expect((await f.query())[0]?.unreadCount).toBe(0);
    vi.advanceTimersByTime(120000);
    f.service.observeNewMessages(f.change);
    f.service.observeNewMessages(f.change);
    expect((await f.query())[0]?.unreadCount).toBe(1);
    const reopened = new UnreadInfoService(f.session, undefined, { statePath: f.path });
    expect(
      (await reopened.getUnreadInfos([{ chatType: 1, uid: 'u_fixture' }]))[0]?.unreadCount,
    ).toBe(1);
    await f.service.markReadAndReport(1, 'u_fixture', '9001');
    expect((await f.query())[0]?.unreadCount).toBe(0);
    expect(f.markRead).toHaveBeenCalledWith(1, 'u_fixture', '9001');
  });

  it('静态目录只写本地位置，群消息排除自己，关闭服务后不接收旧事件', async () => {
    const f = setup(true);
    f.service.observeNewMessages(f.change);
    expect((await f.query())[0]?.unreadCount).toBe(0);
    await f.service.markReadAndReport(1, 'u_fixture', '9000');
    expect(f.markRead).not.toHaveBeenCalled();
    const live = setup();
    const msg = { ...live.base, targetGroupCode: '70001' };
    live.service.observeNewMessages({
      ...live.change,
      c2c: [],
      group: [
        msg,
        { ...msg, msgSeq: 9002n, senderUid: 'u_self' },
        { ...msg, msgSeq: 9003n, senderUin: 10001n },
      ],
    });
    const row = { ...snapshot('9003'), chatType: 2, uid: '70001', peer: '2_70001' };
    live.getUnreadInfos.mockResolvedValue([row]);
    expect((await live.query())[0]?.unreadCount).toBe(1);
    live.service.dispose();
    live.service.observeNewMessages({
      ...live.change,
      c2c: [],
      group: [{ ...msg, msgSeq: 9004n }],
    });
    expect((await live.query())[0]?.readError).toBe(true);
    expect(new LocalUnreadStore(live.path).resolve(row).unreadCount).toBe(1);
  });

  it('旧查询晚于阅读返回，不降低水位；损坏快照不自动标记已读', async () => {
    const f = setup();
    let release: ((rows: UnreadInfoSnapshot[]) => void) | undefined;
    f.getUnreadInfos.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.query();
    await f.service.markLocalRead(1, 'u_fixture', '9000');
    release!([snapshot('9000', 8000)]);
    expect((await pending)[0]?.unreadCount).toBe(0);
    f.getUnreadInfos.mockResolvedValue([{ ...snapshot(), readError: true }]);
    expect((await f.service.markReadAndReport(1, 'u_fixture', '9000')).report.state).toBe(
      'unavailable',
    );
    expect(f.markRead).not.toHaveBeenCalled();
  });

  it('批量手动标记去重并可撤销，既不写 QQ 库也不上报', async () => {
    const f = setup(true);
    const rows = [
      snapshot('9000', 8990),
      { ...snapshot('40', 40), chatType: 2, uid: '70001', peer: '2_70001' },
    ];
    f.getUnreadInfos.mockResolvedValue(rows);
    const targets = rows.map(({ chatType, uid }) => ({ chatType, uid }));
    const result = await f.service.setReadState([...targets, targets[0]!], false);
    expect(f.getUnreadInfos).toHaveBeenCalledWith(targets, {
      selfUid: 'u_self',
      selfUin: '10001',
    });
    expect(result.rows.map((row) => row.unreadCount)).toEqual([0, 0]);
    expect(f.markRead).not.toHaveBeenCalled();
    f.service.observeNewMessages(f.change);
    f.getUnreadInfos.mockResolvedValue([{ ...rows[0]!, latestSeq: '9001' }, rows[1]!]);
    const undone = await f.service.undoReadState(result.undoToken);
    expect(undone.restored).toBe(2);
    expect(undone.rows.map((row) => row.unreadCount)).toEqual([11, 0]);
    await expect(f.service.undoReadState(result.undoToken)).rejects.toThrow('失效');
  });

  it('读错误时整批不变，撤销失败保留重试机会，账号关闭后令牌失效', async () => {
    const f = setup();
    const target = [{ chatType: 1, uid: 'u_fixture' }];
    const marked = await f.service.setReadState(target, true);
    f.getUnreadInfos.mockResolvedValue([{ ...snapshot('9000'), readError: true }]);
    await expect(f.service.setReadState(target, false)).rejects.toThrow('读取失败');
    await expect(f.service.undoReadState(marked.undoToken)).rejects.toThrow('读取失败');
    f.getUnreadInfos.mockResolvedValue([snapshot('9000')]);
    expect((await f.query())[0]?.unreadCount).toBe(1);
    expect((await f.service.undoReadState(marked.undoToken)).restored).toBe(1);
    const later = await f.service.setReadState(target, true);
    f.service.dispose();
    await expect(f.service.undoReadState(later.undoToken)).rejects.toThrow('失效');
  });

  it('持久化失败回滚内存标记，撤销写盘失败后仍可重试', async () => {
    const f = setup(true);
    const target = [{ chatType: 1, uid: 'u_fixture' }];
    const flush = vi.spyOn(LocalUnreadStore.prototype, 'flush');
    try {
      flush.mockImplementationOnce(() => {
        throw new Error('磁盘写入失败');
      });
      await expect(f.service.setReadState(target, true)).rejects.toThrow('磁盘写入失败');
      expect((await f.query())[0]?.unreadCount).toBe(0);
      const change = await f.service.setReadState(target, true);
      flush.mockImplementationOnce(() => {
        throw new Error('磁盘写入失败');
      });
      await expect(f.service.undoReadState(change.undoToken)).rejects.toThrow('磁盘写入失败');
      expect((await f.query())[0]?.unreadCount).toBe(1);
      expect((await f.service.undoReadState(change.undoToken)).restored).toBe(1);
      expect((await f.query())[0]?.unreadCount).toBe(0);
    } finally {
      flush.mockRestore();
    }
  });

  it('可写账号手动已读、未读和撤销写库，只读目录不写 QQ 库', async () => {
    const f = setup();
    const targets = [{ chatType: 1, uid: 'u_fixture' }];
    const marked = await f.service.setReadState(targets, true);
    expect(f.setReadState).toHaveBeenCalledWith(1, 'u_fixture', '8999', '9000', true);
    expect((await f.service.undoReadState(marked.undoToken)).restored).toBe(1);
    expect(f.undoReadState).toHaveBeenCalledTimes(1);
    await f.service.setReadState(targets, false);
    expect(f.setReadState).toHaveBeenLastCalledWith(1, 'u_fixture', '9000', '9000', false);
    const offline = setup(true);
    const local = await offline.service.setReadState(targets, true);
    await offline.service.undoReadState(local.undoToken);
    expect(offline.setReadState).not.toHaveBeenCalled();
    expect(offline.undoReadState).not.toHaveBeenCalled();
  });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-'));
  roots.push(root);
  const path = join(root, 'read.json');
  return { path, store: new LocalUnreadStore(path) };
}
function snapshot(latestSeq = '5000', msgSeq?: number): UnreadInfoSnapshot {
  return { chatType: 1, uid: 'u_fixture', peer: '1_u_fixture', latestSeq, msgSeq };
}
const highlight = {
  kind: 'atMe' as const,
  rawKind: 1000,
  msgSeq: 4999,
  senderUid: 'u_peer',
  sendTime: 1,
  text: '',
};

describe('本地未读基线', () => {
  it('QQ 已读水位滞后时扣除自己发送的序号，不清除夹在其中的入站和手动未读', () => {
    const { store } = fixture();
    store.resolve(snapshot('5000', 5000));
    const sent = {
      ...snapshot('5002', 5000),
      outgoingSeqs: ['5000', '5001', '5002', '5002', '9999'],
    };
    expect(store.resolve(sent).unreadCount).toBe(0);
    store.recordLive(1, 'u_fixture', '5003');
    const mixed = { ...snapshot('5004', 5000), outgoingSeqs: ['5001', '5002', '5004'] };
    expect(store.resolve(mixed).unreadCount).toBe(1);
    store.markRead(1, 'u_fixture', '5003');
    expect(store.resolve(mixed).unreadCount).toBe(0);
    store.setManualRead(store.resolve(mixed), true);
    expect(
      store.resolve({ ...snapshot('5005', 5000), outgoingSeqs: [...mixed.outgoingSeqs, '5005'] })
        .unreadCount,
    ).toBe(1);
    store.recordLive(1, 'u_fixture', '5006');
    expect(
      store.resolve({ ...snapshot('5006', 5000), outgoingSeqs: [...mixed.outgoingSeqs, '5005'] })
        .unreadCount,
    ).toBe(2);
  });

  it('手动已读即时覆盖旧快照，撤销恢复原未读且不吞掉期间的新消息', () => {
    const { store, path } = fixture();
    const row = snapshot('5000', 4990);
    const before = store.resolve(row);
    const change = store.setManualRead(before, false);
    expect(store.resolve(row).unreadCount).toBe(0);
    store.recordLive(1, 'u_fixture', '5001');
    expect(store.resolve(snapshot('5001', 4990)).unreadCount).toBe(1);
    expect(store.restoreManualRead(1, 'u_fixture', change)).toBe(true);
    expect(store.resolve(snapshot('5001', 4990)).unreadCount).toBe(11);
    store.setManualRead(store.resolve(snapshot('5001', 4990)), false);
    store.flush();
    expect(new LocalUnreadStore(path).resolve(snapshot('5001', 4990)).unreadCount).toBe(0);
  });

  it('手动未读跨重启保留，正常阅读后取消，过期撤销不覆盖后续操作', () => {
    const { store, path } = fixture();
    const row = snapshot('5000', 5000);
    const change = store.setManualRead(store.resolve(row), true);
    expect(store.resolve(row).unreadCount).toBe(1);
    store.flush();
    expect(new LocalUnreadStore(path).resolve(row).unreadCount).toBe(1);
    store.markRead(1, 'u_fixture', '5000');
    expect(store.resolve(row).unreadCount).toBe(0);
    expect(store.restoreManualRead(1, 'u_fixture', change)).toBe(false);
    const first = store.setManualRead(store.resolve(row), true);
    const second = store.setManualRead(store.resolve(row), false);
    expect(store.restoreManualRead(1, 'u_fixture', first)).toBe(false);
    expect(store.restoreManualRead(1, 'u_fixture', second)).toBe(true);
    expect(store.resolve(row).unreadCount).toBe(1);
  });

  it('QQ 水位刷新不会自动取消手动未读，高亮只随明确阅读清除', () => {
    const { store } = fixture();
    const row = { ...snapshot('5000', 4990), highlights: [highlight] };
    store.setManualRead(store.resolve(row), false);
    expect(store.resolve(row).highlights).toBeUndefined();
    store.setManualRead(store.resolve(row), true);
    expect(store.resolve(snapshot('5000', 5000)).unreadCount).toBe(1);
  });

  it('缺少已读水位的历史会话首次安静对齐，导入抬高最新序号也不生成未读', () => {
    const { store } = fixture();
    expect(store.resolve(snapshot()).unreadCount).toBe(0);
    expect(store.resolve(snapshot('9000')).unreadCount).toBe(0);
    expect(store.resolve({ ...snapshot(), readError: true }).unreadCount).toBeUndefined();
  });

  it('只累计实时消息并按序号去重，重启保留未读，历史补齐不扩大数字', () => {
    const { store, path } = fixture();
    store.resolve(snapshot());
    store.recordLive(1, 'u_fixture', '5001');
    store.recordLive(1, 'u_fixture', '5001');
    store.recordLive(1, 'u_fixture', '5003');
    expect(store.resolve(snapshot('9000')).unreadCount).toBe(2);
    store.flush();
    const reopened = new LocalUnreadStore(path);
    expect(reopened.resolve(snapshot('9000')).unreadCount).toBe(2);
    expect(reopened.resolve(snapshot('9000')).readSeq).toBe('5000');
    expect(
      new LocalUnreadStore(join(path, '..', 'other.json')).resolve(snapshot()).unreadCount,
    ).toBe(0);
  });

  it('实时事件先于首次快照或晚于快照均不丢失；阅读只清理固定水位内的消息', () => {
    const { store } = fixture();
    store.recordLive(1, 'u_fixture', '5001');
    expect(store.resolve(snapshot('5001')).unreadCount).toBe(1);
    store.markRead(1, 'u_fixture', '5001');
    store.recordLive(1, 'u_fixture', '5002');
    store.recordLive(1, 'u_fixture', '5001');
    expect(store.resolve(snapshot('5002')).unreadCount).toBe(1);
    store.markRead(1, 'u_fixture', '5000');
    expect(store.resolve(snapshot('5002')).unreadCount).toBe(1);
  });

  it('缺水位仍保留明确提醒，同一消息多个提醒不重复计数，读后旧提醒不复活', () => {
    const { store, path } = fixture();
    const row = {
      ...snapshot(),
      highlights: [highlight, { ...highlight, kind: 'replyMe' as const }],
    };
    expect(store.resolve(row)).toMatchObject({ unreadCount: 1, readSeq: '4998' });
    store.markRead(1, 'u_fixture', '5000');
    store.flush();
    expect(new LocalUnreadStore(path).resolve(row)).toMatchObject({
      unreadCount: 0,
      highlights: undefined,
    });
  });

  it('可信 QQ 水位与本地阅读位置取较大者，QQ 水位后来出现或消失不恢复旧未读', () => {
    const { store } = fixture();
    expect(store.resolve(snapshot('5000', 4990)).unreadCount).toBe(10);
    store.markRead(1, 'u_fixture', '4995');
    expect(store.resolve(snapshot('5000', 4990)).unreadCount).toBe(5);
    expect(store.resolve(snapshot('5000', 5000)).unreadCount).toBe(0);
    expect(store.resolve(snapshot('5000', 4990)).unreadCount).toBe(0);
    expect(store.resolve(snapshot('5000')).unreadCount).toBe(0);
    expect(store.resolve(snapshot('5', 0)).unreadCount).toBe(0);
    expect(
      store.resolve({ ...snapshot('5', 0), uid: 'u_other', peer: '1_u_other' }).unreadCount,
    ).toBe(5);
  });

  it('同 UID 的不同会话类型不串状态，损坏存储安全对齐', () => {
    const { store, path } = fixture();
    store.recordLive(1, 'u_fixture', '5001');
    expect(store.resolve({ ...snapshot(), chatType: 2, peer: '2_u_fixture' }).unreadCount).toBe(0);
    writeFileSync(path, '{broken');
    expect(new LocalUnreadStore(path).resolve(snapshot()).unreadCount).toBe(0);
    writeFileSync(path, JSON.stringify({ '1_u_fixture': { latestSeq: '-1', pending: ['bad'] } }));
    expect(new LocalUnreadStore(path).resolve(snapshot()).unreadCount).toBe(0);
  });

  it('已有 QQ 水位时，最新序号刷新落后于实时事件或明确提醒也不吞掉未读', () => {
    const { store } = fixture();
    store.resolve(snapshot('5000', 5000));
    store.recordLive(1, 'u_fixture', '5001');
    expect(store.resolve(snapshot('5000', 5000)).unreadCount).toBe(1);
    expect(
      store.resolve({ ...snapshot('5000', 5000), highlights: [{ ...highlight, msgSeq: 5002 }] })
        .unreadCount,
    ).toBe(2);
  });

  it('未知基线之后 QQ 提供较旧水位，不重新计入历史，也不清掉基线内已捕获的实时提醒', () => {
    const { store, path } = fixture();
    store.resolve(snapshot());
    store.recordLive(1, 'u_fixture', '5001');
    store.resolve(snapshot('9000'));
    store.flush();
    const reopened = new LocalUnreadStore(path);
    expect(reopened.resolve(snapshot('9000', 0))).toMatchObject({
      unreadCount: 1,
      readSeq: '5000',
    });
    expect(reopened.resolve(snapshot('9000', 5001)).unreadCount).toBe(0);
    expect(reopened.resolve(snapshot('9001', 5001)).unreadCount).toBe(1);
  });
});
