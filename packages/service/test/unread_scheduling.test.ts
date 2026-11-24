import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { UnreadInfoSnapshot, UnreadReadChange } from '@weq/db';
import { databaseRequestSignal, withDatabasePriority } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub } from '@weq/testkit';
import { afterEach, expect, it, vi } from 'vitest';
import { UnreadInfoService, type UnreadSequenceRange } from '../src/account/unread_info';
import type { GapFetchedMessage } from '../src/account/gap_history';
import { RecallArchive } from '../src/account/recall_archive';
import { RoamMsgCacheDb } from '../src/account/roam_msg_cache';

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
function fixture(
  readOnly = false,
  unreadSentSequences?: (ranges: UnreadSequenceRange[]) => Promise<Map<string, string[]>>,
  recallArchive?: RecallArchive,
) {
  let rows = [row()];
  let original = row();
  const signals: Array<AbortSignal | undefined> = [];
  const all = vi.fn(async () => {
    signals.push(databaseRequestSignal());
    return rows.map((r) => ({ ...r }));
  });
  const targeted = vi.fn(async (targets: { chatType: number; uid: string }[]) =>
    rows
      .filter((row) => targets.some((t) => t.chatType === row.chatType && t.uid === row.uid))
      .map((row) => ({ ...row })),
  );
  const setReadState = vi.fn(
    async (
      chatType: number,
      uid: string,
      readSeq: string,
      _through: string,
      unread: boolean,
    ): Promise<UnreadReadChange> => {
      original = rows.find((row) => row.uid === uid && row.chatType === chatType)!;
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
  const undoReadState = vi.fn(async ({ chatType, uid }: UnreadReadChange) => {
    rows = rows.map((row) =>
      row.chatType === chatType && row.uid === uid
        ? { ...row, msgSeq: original.msgSeq, markUnread: original.markUnread }
        : row,
    );
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
      getUnreadInfos: targeted,
      setReadState,
      undoReadState,
      markRead,
    },
  } as unknown as AccountSession;
  const service = new UnreadInfoService(
    session,
    undefined,
    readOnly || unreadSentSequences || recallArchive
      ? { statePath: '', readOnly, unreadSentSequences, recallArchive }
      : undefined,
  );
  services.push(service);
  return {
    service,
    all,
    targeted,
    signals,
    setReadState,
    markRead,
    undoReadState,
    query: (fast = false) => service.getUnreadInfos([target], fast),
    update: (next: UnreadInfoSnapshot[], notify = true) => {
      rows = next;
      if (notify) service.invalidate();
    },
  };
}

it('跨端已读覆盖当前末条时直接收敛，较旧推送和手动未读不会被覆盖', async () => {
  const { service, all, update, markRead } = fixture();
  await service.getUnreadInfos([target]);
  const readsBefore = all.mock.calls.length;
  service.observeProxyReads([{ ...target, sequence: '100' }]);
  service.observeProxyReads([{ ...target, sequence: '95' }]);
  expect((await service.getUnreadInfos([target], false, true))[0]).toMatchObject({
    readSeq: '100',
    unreadCount: 0,
  });
  expect(all).toHaveBeenCalledTimes(readsBefore);
  expect(markRead).not.toHaveBeenCalled();

  update([row({ markUnread: true })]);
  expect((await service.getUnreadInfos([target], false, true))[0]?.markUnread).toBe(true);
  await service.setReadState([target], true);
  expect((await service.getUnreadInfos([target], false, true))[0]?.markUnread).toBe(true);
});

it('跨端部分已读只补读目标会话，关闭代理后清掉临时水位', async () => {
  const { service, all, update } = fixture();
  await service.getUnreadInfos([target]);
  const readsBefore = all.mock.calls.length;
  service.observeProxyReads([{ ...target, sequence: '95' }]);
  update([row({ msgSeq: 95 })], false);
  await vi.waitFor(async () =>
    expect((await service.getUnreadInfos([target], false, true))[0]?.readSeq).toBe('95'),
  );
  expect(all).toHaveBeenCalledTimes(readsBefore);
  service.observeProxyReads([{ ...target, sequence: '100' }]);
  service.clearProxyReads();
  expect((await service.getUnreadInfos([target], false, true))[0]?.readSeq).toBe('95');
});

it('完整已读推送覆盖待校准的部分水位时取消重复读库', async () => {
  const { service, targeted } = fixture();
  await service.getUnreadInfos([target]);
  vi.useFakeTimers();
  const readsBefore = targeted.mock.calls.length;
  const publish = vi.fn();
  service.onCountsChanged(publish);
  service.observeProxyReads([{ ...target, sequence: '95' }]);
  service.observeProxyReads([{ ...target, sequence: '100' }]);
  await vi.advanceTimersByTimeAsync(300);
  expect(targeted).toHaveBeenCalledTimes(readsBefore);
  expect(publish.mock.calls).toEqual([[[target]]]);
  expect((await service.getUnreadInfos([target], false, true))[0]).toMatchObject({
    readSeq: '100',
    unreadCount: 0,
  });
});

it('代理未读叠加已确认快照，合并重放和随后到来的 QQ 落库', async () => {
  const { service, update, markRead } = fixture();
  await service.getUnreadInfos([target]);
  service.observeLiveUnread(target, ['101', '101']);
  expect((await service.getUnreadInfos([target], false, true))[0]?.unreadCount).toBe(11);
  const seen = await service.visibleReadSequence(2, target.uid, [
    '91',
    '92',
    '93',
    '94',
    '95',
    '96',
    '97',
    '98',
    '99',
    '100',
    '101',
  ]);
  expect(seen).toBe('101');
  expect((await service.markReadAndReport(2, target.uid, seen)).changed).toBe(true);
  expect(markRead).not.toHaveBeenCalled();
  update([row({ latestSeq: '101' })]);
  await service.getUnreadInfos([target]);
  await vi.waitFor(() => expect(markRead).toHaveBeenCalledWith(2, target.uid, '101'));
  expect((await service.getUnreadInfos([target], false, true))[0]?.unreadCount).toBe(0);
});

it('不同批次和兼容轻量请求共用初始化快照，后续读取不发 SQL', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.query(), f.query(true)]);
  expect(a).toEqual(b);
  expect(a[0]?.unreadCount).toBe(10);
  for (let i = 0; i < 20; i++) expect((await f.query())[0]).toBe(a[0]);
  expect(f.all).toHaveBeenCalledOnce();
});

it('未读字段等值时保留原结果，同水位仍发布提醒内容变更', async () => {
  const f = fixture();
  await f.query();
  const highlight = {
    kind: 'atMe' as const,
    rawKind: 1000,
    msgSeq: 91,
    senderUid: 'u_peer',
    sendTime: 1,
    text: '旧提醒',
  };
  const initial = row({ decreasedSeqs: ['93'], highlights: [highlight] });
  f.update([initial], false);
  await f.service.compareQqCounts();
  const [before] = await f.query();
  const changed = vi.fn();
  const stop = f.service.onCountsChanged(changed);
  try {
    f.update(
      [
        {
          highlights: [{ ...highlight }],
          decreasedSeqs: ['93'],
          latestSeq: '100',
          msgSeq: 90,
          peer: initial.peer,
          ...target,
          localReadSeq: undefined,
        },
      ],
      false,
    );
    await f.service.compareQqCounts();
    expect(changed).not.toHaveBeenCalled();
    expect((await f.query())[0]).toBe(before);
    f.update(
      [row({ decreasedSeqs: ['93'], highlights: [{ ...highlight, text: '新提醒' }] })],
      false,
    );
    await f.service.compareQqCounts();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith([target]);
    expect((await f.query())[0]?.highlights?.[0]?.text).toBe('新提醒');
  } finally {
    stop();
  }
});

it('小表全部命中在自动已读及手动已读清理前归档，列表不增加历史查询', async () => {
  const f = fixture();
  const highlights: NonNullable<UnreadInfoSnapshot['highlights']> = [101, 102].map((msgSeq) => ({
    kind: 'atMe',
    rawKind: 1000,
    msgSeq,
    senderUid: 'u_peer',
    sendTime: 1,
    text: '',
  }));
  f.update([row({ latestSeq: '102', highlights })]);
  await f.query();
  await f.service.markRead(2, target.uid, '102');
  f.update([row({ latestSeq: '102', msgSeq: 102 })]);
  const page = await f.service.listImportantMessages({ ...target, limit: 50 });
  expect(page.items.map((item) => item.msgSeq)).toEqual(['102', '101']);
  expect(page.items.every((item) => !item.unread)).toBe(true);
  f.update([
    row({ latestSeq: '103', msgSeq: 102, highlights: [{ ...highlights[0]!, msgSeq: 103 }] }),
  ]);
  await f.service.setReadState([target], false);
  f.update([row({ latestSeq: '103', msgSeq: 103 })]);
  expect((await f.service.listImportantMessages({ ...target, limit: 50 })).items).toHaveLength(3);
});
it.each([1, 2])('类型 %s 的跨端自发消息在 QQ 减项到达前后都不增加未读', async (chatType) => {
  const f = fixture();
  await f.query();
  const identity = { chatType, uid: target.uid, peer: `${chatType}_${target.uid}` };
  const query = () => f.service.getUnreadInfos([identity]);
  f.update([row({ ...identity, msgSeq: 100, latestSenderUid: 'u_peer' })]);
  expect((await query())[0]?.unreadCount).toBe(0);
  f.update([row({ ...identity, msgSeq: 100, latestSeq: '101', latestSenderUid: 'u_self' })]);
  expect((await query())[0]?.unreadCount).toBe(0);
  f.update([row({ ...identity, msgSeq: 100, latestSeq: '102', latestSenderUid: 'u_peer' })]);
  expect((await query())[0]?.unreadCount).toBe(1);
  f.update([
    row({
      ...identity,
      msgSeq: 100,
      latestSeq: '102',
      latestSenderUid: 'u_peer',
      decreasedSeqs: ['101'],
    }),
  ]);
  expect((await query())[0]?.unreadCount).toBe(1);
  f.update([
    row({
      ...identity,
      msgSeq: 100,
      latestSeq: '103',
      latestSenderUid: 'u_self',
      decreasedSeqs: ['101'],
    }),
  ]);
  expect((await query())[0]?.unreadCount).toBe(1);
  expect(f.markRead).not.toHaveBeenCalled();
  expect(f.setReadState).not.toHaveBeenCalled();
});
it('代理留存的撤回在 QQ 小表未变时清除 @全体 未读，重开后仍保留原阅读水位', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-retained-recall-'));
  const path = join(root, 'retained.db');
  const nt = createSqliteStub();
  const archive = new RecallArchive(
    nt,
    path,
    () => true,
    (message) => {
      f.service.invalidateRecall(message.kind, message.conv);
    },
  );
  const f = fixture(false, undefined, archive);
  const unread = row({
    msgSeq: 100,
    latestSeq: '101',
    latestSenderUid: 'u_peer',
    highlights: [
      { kind: 'atAll', rawKind: 2000, msgSeq: 101, senderUid: 'u_peer', sendTime: 1, text: '' },
    ],
  });
  try {
    await f.query();
    f.update([unread]);
    await archive.observe([
      {
        kind: 'group',
        conv: target.uid,
        msgId: '9001',
        msgSeq: '101',
        senderUid: 'u_peer',
        senderUin: '20002',
        sendTime: '1',
        ntSeqVerified: true,
        elements: [{ type: 'text', data: { textContent: '@全体 测试' } }],
      },
    ]);
    expect((await f.query())[0]).toMatchObject({ unreadCount: 1, highlights: unread.highlights });

    await archive.observe(
      [],
      [
        {
          kind: 'group',
          conv: target.uid,
          sequence: 101,
          senderUid: 'u_peer',
          revokeUid: 'u_peer',
          at: Math.floor(Date.now() / 1000),
        },
      ],
    );
    const [recalled] = await f.query();
    expect(recalled).toMatchObject({ unreadCount: 0, readSeq: '100', recalledSeqs: ['101'] });
    expect(recalled?.highlights).toBeUndefined();
    expect(f.markRead).not.toHaveBeenCalled();
    expect(f.setReadState).not.toHaveBeenCalled();

    await archive.close();
    const reopened = new RecallArchive(nt, path, () => false, vi.fn());
    const fresh = fixture(false, undefined, reopened);
    await fresh.query();
    fresh.update([unread]);
    expect((await fresh.query())[0]).toMatchObject({ unreadCount: 0, readSeq: '100' });
    fresh.update([{ ...unread, latestSeq: '102', decreasedSeqs: ['101'] }]);
    expect((await fresh.query())[0]?.unreadCount).toBe(1);
    await fresh.service.dispose();
    await reopened.close();
  } finally {
    await f.service.dispose();
    closeAllFixtureDbs();
    rmSync(root, { recursive: true, force: true });
  }
});
it('戳一戳推进小表时扣除已确认自发序号，并在缓存晚到时重算原快照', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-unread-sent-'));
  const cache = new RoamMsgCacheDb(createSqliteStub(), join(root, 'cache.db'));
  const sent: GapFetchedMessage = {
    kind: 'c2c',
    conv: 'u_peer',
    msgId: '64',
    msgSeq: '18064',
    senderUid: 'u_self',
    senderUin: '10001',
    sendTime: '1700000000',
    sourceFormat: 'protocol',
    ntSeqVerified: true,
    localSent: true,
    elements: [{ type: 'text', data: { textContent: '原文' } }],
  };
  const readSent = vi.fn((ranges: UnreadSequenceRange[]) =>
    cache.unreadSentSequences('u_self', ranges),
  );
  const direct = { chatType: 1, uid: sent.conv, peer: '1_u_peer' };
  const f = fixture(false, readSent);
  const query = () => f.service.getUnreadInfos([direct]);
  try {
    await f.query();
    await cache.store([
      sent,
      { ...sent, msgId: '65', msgSeq: '18065' },
      { ...sent, msgId: '66', msgSeq: '18066', ntSeqVerified: false },
      { ...sent, msgId: '166', msgSeq: '18066', senderUid: 'u_other' },
    ]);
    f.update([row({ ...direct, msgSeq: 18063, latestSeq: '18065', latestSeqNonMessage: true })]);
    expect((await query())[0]).toMatchObject({ unreadCount: 0, readSeq: '18063' });
    f.update([row({ ...direct, msgSeq: 18063, latestSeq: '18066', latestSenderUid: 'u_peer' })]);
    expect((await query())[0]?.unreadCount).toBe(1);
    f.update([row({ ...direct, msgSeq: 18063, latestSeq: '18067', latestSenderUid: 'u_peer' })]);
    expect((await query())[0]?.unreadCount).toBe(2);
    readSent.mockClear();
    f.service.invalidate();
    expect((await query())[0]?.unreadCount).toBe(2);
    expect(readSent).not.toHaveBeenCalled();

    const changed = vi.fn();
    const stop = f.service.onCountsChanged(changed);
    try {
      await cache.store([{ ...sent, msgId: '66', msgSeq: '18066' }]);
      f.service.invalidateSent('c2c', sent.conv);
      await vi.waitFor(() =>
        expect(changed).toHaveBeenCalledWith([{ chatType: 1, uid: sent.conv }]),
      );
      expect((await query())[0]?.unreadCount).toBe(1);
    } finally {
      stop();
    }
    expect(f.markRead).not.toHaveBeenCalled();
  } finally {
    await f.service.dispose();
    closeAllFixtureDbs();
    rmSync(root, { recursive: true, force: true });
  }
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
it('文件监听接管快捷刷新，定时任务低频对账，解除监听后恢复原周期', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  const detach = f.service.attachMessageFileWatch();
  const changed = vi.fn();
  f.service.onCountsChanged(changed);
  await vi.advanceTimersByTimeAsync(50);
  f.all.mockClear();
  await vi.advanceTimersByTimeAsync(5950);
  expect(f.all).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.all).toHaveBeenCalledOnce();
  f.all.mockClear();
  f.update([row({ msgSeq: 95 })]);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.all).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledWith([expect.objectContaining(target)]);
  expect((await f.query())[0]?.unreadCount).toBe(5);
  detach();
  await vi.advanceTimersByTimeAsync(50);
  f.all.mockClear();
  await vi.advanceTimersByTimeAsync(1500);
  expect(f.all).toHaveBeenCalledOnce();
});
it('读取期间到达的文件变动在完成后补一次，不等定时对账', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  f.service.attachMessageFileWatch();
  f.service.onCountsChanged(() => {});
  await vi.advanceTimersByTimeAsync(50);
  let release: ((rows: UnreadInfoSnapshot[]) => void) | undefined;
  f.all.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.all.mockClear();
  f.service.invalidate();
  await vi.advanceTimersByTimeAsync(50);
  expect(f.all).toHaveBeenCalledOnce();
  f.update([row({ msgSeq: 95 })]);
  await vi.advanceTimersByTimeAsync(100);
  expect(f.all).toHaveBeenCalledOnce();
  release?.([row()]);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.all).toHaveBeenCalledTimes(2);
  expect((await f.query())[0]?.unreadCount).toBe(5);
});
const fileChange = () => ({
  dbPath: '/synthetic/small-unread.db',
  at: Date.now(),
  prevTotal: 1,
  total: 2,
  delta: 1,
  files: [],
});
it('一次库文件变化及迟到消息通知共用已经完成的快照', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const f = fixture();
  await f.query();
  f.service.attachMessageFileWatch();
  f.service.onCountsChanged(() => {});
  await vi.advanceTimersByTimeAsync(800);
  f.all.mockClear();
  const file = fileChange();
  f.service.invalidateMessageFile(file);
  await vi.advanceTimersByTimeAsync(800);
  expect(f.all).toHaveBeenCalledOnce();
  await f.service.observeNewMessages({ file, c2c: [], group: [] });
  await vi.advanceTimersByTimeAsync(800);
  expect(f.all).toHaveBeenCalledOnce();
});
it('连续 WAL 变化合并全量读取，本地写入仍优先校准', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  const f = fixture();
  await f.query();
  f.service.attachMessageFileWatch();
  f.service.onCountsChanged(() => {});
  await vi.advanceTimersByTimeAsync(800);
  f.all.mockClear();
  f.service.invalidateMessageFile(fileChange());
  await vi.advanceTimersByTimeAsync(50);
  expect(f.all).toHaveBeenCalledOnce();
  for (let i = 0; i < 6; i++) {
    f.service.invalidateMessageFile(fileChange());
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(f.all).toHaveBeenCalledOnce();
  f.update([row({ msgSeq: 95 })], false);
  await vi.advanceTimersByTimeAsync(150);
  expect(f.all).toHaveBeenCalledTimes(2);
  expect((await f.query())[0]?.unreadCount).toBe(5);
  f.service.invalidateMessageFile(fileChange());
  f.update([row({ msgSeq: 98 })]);
  await vi.advanceTimersByTimeAsync(50);
  expect(f.all).toHaveBeenCalledTimes(3);
  expect((await f.query())[0]?.unreadCount).toBe(2);
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
it('可写批量标记只显示实际保存的结果，撤销不包含失败会话', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  f.setReadState.mockRejectedValueOnce(new Error('busy'));
  const other = row({ uid: '70002', peer: '2_70002' });
  f.update([other, row()]);
  const result = await f.service.setReadState([other, target], false);
  expect(result.failed).toBe(1);
  expect(result.rows.map((row) => row.unreadCount)).toEqual([10, 0]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.setReadState).toHaveBeenCalledTimes(2);
  expect((await f.service.undoReadState(result.undoToken)).restored).toBe(1);
  expect(f.undoReadState).toHaveBeenCalledWith(expect.objectContaining(target));
});
it('自动阅读写库失败不清角标，按原位置重试成功后才更新', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  f.markRead.mockRejectedValueOnce(new Error('busy'));
  expect(await f.service.markRead(2, '70001', '100')).toBe(false);
  f.update([row({ latestSeq: '102' })]);
  expect((await f.query())[0]?.unreadCount).toBe(12);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.setReadState).toHaveBeenLastCalledWith(2, '70001', '100', '100', false);
  expect((await f.query())[0]?.unreadCount).toBe(2);
});
it('QQ 已先清除文件提醒时，自动标已读即使无需写入也立即回读旧缓存', async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.query();
  f.update([
    row({
      highlights: [
        {
          kind: 'newFile',
          rawKind: 2004,
          msgSeq: 99,
          senderUid: 'u_peer',
          sendTime: 1,
          text: '',
        },
      ],
    }),
  ]);
  expect((await f.query())[0]?.highlights?.[0]?.kind).toBe('newFile');
  f.all.mockClear();
  const unsubscribe = f.service.onCountsChanged(() => {});
  try {
    f.update([row({ msgSeq: 100 })]);
    f.markRead.mockResolvedValueOnce(false);
    expect(await f.service.markRead(2, target.uid, '100')).toBe(false);
    expect((await f.query())[0]).toMatchObject({ readSeq: '100', unreadCount: 0 });
    expect((await f.query())[0]?.highlights).toBeUndefined();
    expect(f.all).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
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
  expect(f.setReadState).toHaveBeenLastCalledWith(2, '70001', '90', '100', true);
  expect((await f.query())[0]?.unreadCount).toBe(1);
});

it('撤销写库暂时失败自动重试原撤销，不用普通已读写入冒充降低水位', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const change = await f.service.setReadState([target], false);
  f.undoReadState.mockRejectedValueOnce(new Error('busy'));
  expect(await f.service.undoReadState(change.undoToken)).toMatchObject({
    restored: 0,
    pending: 1,
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.undoReadState).toHaveBeenCalledTimes(2);
  expect((await f.query())[0]?.unreadCount).toBe(10);
});
