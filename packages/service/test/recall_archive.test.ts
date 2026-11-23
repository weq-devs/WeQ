import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';
import { RecallArchive } from '../src/account/recall_archive';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import { mergeRoamingTimeline } from '../src/common/roaming_timeline';
import type { AccountSession } from '@weq/account';
import { AntiRecallDb, type C2cMsg } from '@weq/db';
import type { Platform } from '@weq/platform';
import { AntiRecallService } from '../src/account/anti_recall';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('巡查逐批读取固定上界内的待确认快照，已撤回正文和半途新增交给各自的路径', async () => {
  const { archive } = setup();
  await archive.observe([]);
  const sql = fixtureDb(archive.path);
  const insert = sql.prepare(
    "INSERT INTO recall_snapshot(identity,kind,conv,msg_id,observed,recalled,payload) VALUES (?,'c2c','u_peer',?,?,?,'{}')",
  );
  const now = Date.now();
  for (let i = 1; i <= 270; i++) insert.run(String(i), String(i), now, i === 129 ? 1 : 0);
  const pages = archive.pendingNativeIdPages();
  const first = await pages.next();
  expect(first.value).toHaveLength(128);
  insert.run('late', '999', now, 0);
  const remaining = [];
  for await (const page of pages) {
    expect(page.length).toBeLessThanOrEqual(128);
    remaining.push(...page.map(({ id }) => id));
  }
  expect(remaining).toEqual(Array.from({ length: 141 }, (_, index) => String(index + 130)));
});

it('留存容量与过期修剪保留已撤回正文，同刻新增优先保留', async () => {
  const { archive } = setup();
  await archive.observe([]);
  const sql = fixtureDb(archive.path);
  const insert = sql.prepare(
    "INSERT INTO recall_snapshot(identity,kind,conv,msg_id,observed,recalled,payload) VALUES (?,'c2c','u_peer',?,?,?,'{}')",
  );
  const now = Date.now();
  sql.exec('BEGIN');
  for (let i = 1; i <= 10001; i++) insert.run(String(i), String(i), now, 0);
  insert.run('expired', 'expired', now - 8 * 86400_000, 0);
  insert.run('retained', 'retained', now - 8 * 86400_000, 1);
  sql.exec('COMMIT');
  await archive.observe([]);
  expect(
    sql.prepare('SELECT COUNT(*) AS count FROM recall_snapshot WHERE recalled=0').get(),
  ).toEqual({
    count: 10000,
  });
  expect(
    sql
      .prepare("SELECT identity FROM recall_snapshot WHERE identity IN ('1','expired','retained')")
      .all(),
  ).toEqual([{ identity: 'retained' }]);
});

it('新增原文只匹配相关会话，重开后仍能恢复已经写入但未匹配的旧记录', async () => {
  const f = setup();
  const archive = new RecallArchive(f.nt, f.path, () => true, f.notify);
  const other = { ...f.recall, conv: 'u_other' };
  await archive.observe([], [f.recall, other]);
  const reads = vi.spyOn(f.nt, 'executeSql');
  await archive.observe([f.original]);
  expect(
    reads.mock.calls.filter(([, statement]) => statement.includes('SELECT payload,recalled')),
  ).toHaveLength(1);
  expect(f.notify.mock.calls.map(([message]) => message.conv)).toEqual(['u_peer']);

  // 模拟旧进程在写入原文之后、尚未匹配待确认撤回时退出。
  const original = { ...f.original, conv: 'u_other', msgId: '9002' };
  fixtureDb(f.path)
    .prepare("INSERT INTO recall_snapshot VALUES (?,'c2c','u_other','9002',42,'u_peer','8',?,0,?)")
    .run('c2c:u_other:42:u_peer:77', Date.now(), JSON.stringify(original));
  const reopened = new RecallArchive(f.nt, f.path, () => true, f.notify);
  await reopened.observe([f.original]);
  expect(f.notify.mock.calls.map(([message]) => message.conv)).toEqual(['u_peer', 'u_other']);
});

it('数据库读取原文后识别灰条，无代理时也能保存撤回正文', async () => {
  const f = setup();
  const native: C2cMsg = {
    msgId: 9001n,
    msgSeq: 42n,
    msgRandom: 77n,
    clientSeq: 8n,
    targetUid: 'u_peer',
    targetUin: 20002n,
    senderUid: 'u_peer',
    senderUin: 20002n,
    sendTime: 1700000000n,
    elements: [{ kind: 'text', textContent: '数据库原文' } as C2cMsg['elements'][number]],
  };
  await f.archive.observeNative([native]);
  await f.archive.observeNative([
    {
      ...native,
      elements: [
        {
          kind: 'grayTipRevoke',
          recallSenderUid: 'u_peer',
          recallRevokeUid: 'u_peer',
          recallElements: [],
        } as unknown as C2cMsg['elements'][number],
      ],
    },
  ]);
  const rows = await f.archive.list();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.elements[0]).toMatchObject({ type: 'text', data: { textContent: '数据库原文' } });
  expect(rows[0]?.recall?.sameSender).toBe(true);
});

it('真实私聊契约的协议 newId 与 QQ 本地 ID 不同，按发送方、clientSequence 和发送时间关联', async () => {
  const f = setup();
  await f.archive.observe([
    f.original,
    { ...f.original, msgId: '9002', msgSeq: '43', sendTime: '1700000001' },
  ]);
  await f.archive.observe(
    [],
    [{ ...f.recall, messageUid: '72057594037927937', timestamp: 1700000000 }],
  );
  expect((await f.archive.list()).map((row) => row.msgId)).toEqual(['9001']);
});

it('旧设置沿用触发器，四档切换共用名单，只有数据库档安装触发器', async () => {
  const f = setup();
  const config = join(roots.at(-1)!, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({ enabled: true, mode: 'selected', targets: [{ kind: 'c2c', id: 'u_peer' }] }),
  );
  const reconcile = vi.spyOn(AntiRecallDb.prototype, 'reconcile').mockResolvedValue(undefined);
  vi.spyOn(AntiRecallDb.prototype, 'status').mockResolvedValue([]);
  const service = new AntiRecallService(
    {
      msgDbPath: join(roots.at(-1)!, 'qq.db'),
      context: { uin: '10001', algos: {} },
    } as AccountSession,
    { native: { ntHelper: f.nt }, isQqLoggedIn: () => false } as unknown as Platform,
    config,
  );
  expect(service.protection().method).toBe('database');
  for (const method of ['weq', 'proxy', 'off'] as const) {
    await service.setMethod(method);
    await service.applyTriggers();
    expect(reconcile).toHaveBeenLastCalledWith([], false);
    expect(service.protection().targets).toEqual([{ kind: 'c2c', id: 'u_peer' }]);
  }
  await service.setMethod('database');
  await service.applyTriggers();
  expect(reconcile).toHaveBeenLastCalledWith([{ kind: 'c2c', id: 'u_peer' }], false);
  await service.dispose();
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'recall-archive-'));
  roots.push(root);
  const nt = createSqliteStub();
  const notify = vi.fn();
  const path = join(root, 'retained.db');
  const protects = (kind: string, conv: string) => kind === 'c2c' && conv === 'u_peer';
  const archive = new RecallArchive(nt, path, protects, notify);
  const history = new GapHistoryService(
    nt,
    { selfUid: 'u_self' } as AccountSession,
    () => 1,
    join(root, 'roam.db'),
    undefined,
    archive,
  );
  const original: GapFetchedMessage = {
    kind: 'c2c',
    conv: 'u_peer',
    msgId: '9001',
    msgSeq: '42',
    clientSeq: '8',
    msgRandom: '77',
    senderUid: 'u_peer',
    senderUin: '20002',
    sendTime: '1700000000',
    ntSeqVerified: true,
    elements: [{ type: 'text', data: { textContent: '撤回前原文' } }],
  };
  const recall = {
    kind: 'c2c' as const,
    conv: 'u_peer',
    senderUid: 'u_peer',
    revokeUid: 'u_peer',
    clientSequence: 8,
    at: Math.floor(Date.now() / 1000),
  };
  return { archive, nt, path, notify, original, recall, history, protects };
}
it('未经过代理的原文也能持久留存、覆盖 QQ 撤回提示，并在重开后读取', async () => {
  const f = setup();
  await f.archive.observe([f.original]);
  await f.archive.observe([], [f.recall]);
  await f.archive.observe([], [f.recall]);
  expect(f.notify).toHaveBeenCalledTimes(1);
  expect(f.notify).toHaveBeenCalledWith(
    expect.objectContaining({ recall: expect.objectContaining({ retained: true }) }),
  );
  const archived = await f.history.cachedTimeline('c2c', 'u_peer', 1, 50, 20, true);
  const gray = { ...f.original, elements: [{ type: 'grayTipRevoke', data: {} }] };
  const unrelated = { ...gray, msgId: '9002', senderUid: '', msgRandom: '0' };
  const result = mergeRoamingTimeline('c2c', [gray, unrelated], archived);
  expect(result).toHaveLength(2);
  expect(result.find((row) => row.msgId === '9001')?.elements).toEqual(f.original.elements);
  expect(result.find((row) => row.msgId === '9001')?.recall?.retained).toBe(true);
  await f.archive.close();
  const reopened = new RecallArchive(f.nt, f.path, f.protects, vi.fn());
  expect((await reopened.list())[0]?.recall).toMatchObject({ revokeUid: 'u_peer', retained: true });
  expect(await f.history.cachedRecalls()).toHaveLength(1);
  expect((await f.history.cachedForDeletion('c2c', 'u_peer', 42))[0]?.elements).toEqual(
    f.original.elements,
  );
  expect((await f.history.cachedDeleted('c2c', 'u_peer', ['roaming:42:9001']))[0]?.msgId).toBe(
    '9001',
  );
  expect((await f.history.findByMsgId('9001'))?.elements).toEqual(f.original.elements);
});
it('撤回先到时等待原文，重复与迟到原文不会覆盖已保留内容', async () => {
  const f = setup();
  await f.archive.observe([], [f.recall]);
  await f.archive.observe([f.original]);
  await f.archive.observe([
    { ...f.original, elements: [{ type: 'text', data: { textContent: '迟到副本' } }] },
  ]);
  expect((await f.archive.list())[0]?.elements).toEqual(f.original.elements);
  expect(f.notify).toHaveBeenCalledTimes(1);
});
it('发送方、会话与消息身份不匹配时不会误标，同 clientSequence 歧义等待精确 ID', async () => {
  const f = setup();
  await f.archive.observe([f.original, { ...f.original, msgId: '9003', msgSeq: '43' }]);
  await f.archive.observe(
    [],
    [f.recall, { ...f.recall, conv: 'u_other' }, { ...f.recall, senderUid: 'u_other' }],
  );
  expect(await f.archive.list()).toEqual([]);
  await f.archive.observe([], [{ ...f.recall, localId: '9001' }]);
  expect((await f.archive.list()).map((row) => row.msgId)).toEqual(['9001']);
});
it('分页游标保持严格推进，关闭功能后已有撤回原文仍可查看', async () => {
  const f = setup();
  await f.archive.observe([f.original, { ...f.original, msgId: '9004', msgSeq: '44' }]);
  await f.archive.observe(
    [],
    [
      { ...f.recall, localId: '9001' },
      { ...f.recall, localId: '9004' },
    ],
  );
  const page = await f.history.cachedTimeline('c2c', 'u_peer', 1, 50, 1, true);
  expect(page.map((row) => row.msgSeq)).toEqual(['44']);
  const next = await f.history.cachedTimeline('c2c', 'u_peer', 1, 50, 1, true, {
    msgSeq: 44,
    sendTime: 1700000000,
    msgId: '9004',
  });
  expect(next.map((row) => row.msgSeq)).toEqual(['42']);
  const off = new RecallArchive(f.nt, f.path, () => false, vi.fn());
  await off.observe([{ ...f.original, msgId: '9005' }]);
  expect(await off.list()).toHaveLength(2);
});
