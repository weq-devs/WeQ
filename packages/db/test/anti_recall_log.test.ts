/**
 * 防撤回记录表的读侧 —— `weq_recall_log` 是触发器写入、WeQ 读出来展示的表。
 *
 * 三个读法各自服务一处 UI / 逻辑：
 *   • listRecalls          → 某个会话的撤回列表（撤回列表面板）
 *   • recallSummaries      → 有撤回记录的会话目录（「更多 → 防撤回 → 记录」页）
 *   • latestRecallBaseline / listRecallsSince → 撤回通知监听器的增量游标
 *
 * 最要紧的行为是**表还没建**（用户从没开过防撤回）时必须优雅返回空，而不是抛
 * "no such table" —— 触发器第一次安装时才会建表。这里用 testkit 的 sqlite stub
 * 覆盖这条路径 + 正常读写路径。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProtoMsg } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { AntiRecallDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const LOG_DDL = `CREATE TABLE IF NOT EXISTS weq_recall_log (
  msgid       INTEGER PRIMARY KEY,
  conv        TEXT,
  table_kind  TEXT,
  sender_uid  TEXT,
  revoke_uid  TEXT,
  orig_seq    INTEGER,
  recall_ts   INTEGER,
  orig_body   BLOB,
  graytip_done INTEGER DEFAULT 0
)`;

let dir: string;
let dbPath: string;
let db: AntiRecallDb;
let nt: ReturnType<typeof createSqliteStub>;

afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

/** 建一个只有记录表的 nt_msg.db（读侧不碰消息表，所以不必建它们）。 */
function createFixture(withLogTable: boolean): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-recall-log-'));
  dbPath = join(dir, 'nt_msg.db');
  const sql = fixtureDb(dbPath);
  if (withLogTable) sql.exec(LOG_DDL);
  nt = createSqliteStub();
  db = new AntiRecallDb(nt, { dbPath, key: 'fixture-key' });
}

function insertRow(
  msgid: number | bigint,
  kind: string,
  conv: string,
  recallTs: number,
  senderUid = 'u_sender',
  revokeUid = 'u_revoker',
): void {
  const sql = fixtureDb(dbPath);
  const stmt = sql.prepare(
    `INSERT INTO weq_recall_log
       (msgid, conv, table_kind, sender_uid, revoke_uid, orig_seq, recall_ts, orig_body, graytip_done)
     VALUES (?,?,?,?,?,?,?,?,0)`,
  );
  // `msgid` can exceed 2^53 (real QQ 40001 is ~7.7e18). node:sqlite refuses to
  // coerce a bigint insert's `lastInsertRowid` back to a JS number unless we opt
  // into bigint reads, so enable it here for the large-id fixture rows.
  stmt.setReadBigInts(true);
  stmt.run(msgid, conv, kind, senderUid, revokeUid, BigInt(msgid) + 1n, recallTs, null);
}

describe('AntiRecallDb recall log (offline fixture)', () => {
  it('确认撤回时先记录未知撤回者，随后补齐身份，普通灰条与未确认的写入不留记录', async () => {
    createFixture(false);
    const setup = fixtureDb(dbPath);
    setup.exec(`CREATE TABLE group_msg_table (
      "40001" INTEGER PRIMARY KEY, "40002" INTEGER, "40003" INTEGER, "40011" INTEGER,
      "40012" INTEGER, "40020" TEXT, "40027" INTEGER, "40800" BLOB
    )`);
    const body = new ProtoMsg(MsgBody);
    const original = body.encode({ elements: [{ elementType: 1, textContent: '原文' }] });
    const insert = setup.prepare(
      `INSERT INTO group_msg_table VALUES (?, 1, ?, 2, 1, 'u_sender', 777, ?)`,
    );
    for (const id of [10, 11, 12, 13]) insert.run(id, id + 1, original);
    await db.reconcile([{ kind: 'group', id: '777' }]);

    const sql = fixtureDb(dbPath);
    const update = sql.prepare('UPDATE group_msg_table SET "40800" = ? WHERE "40001" = ?');
    const unknown = body.encode({
      elements: [
        { elementType: 8, subType: 1, recallRevokeUid: '', recallDisplayText: '消息已撤回' },
      ],
    });
    update.run(unknown, 10);
    update.run(body.encode({ elements: [{ elementType: 8, subType: 4 }] }), 11);
    update.run(body.encode({ elements: [{ elementType: 8 }, { elementType: 8, subType: 1 }] }), 12);
    sql.prepare('UPDATE group_msg_table SET "40011" = 5, "40012" = 4 WHERE "40001" = 13').run();
    expect(await db.listRecalls('group', '777')).toMatchObject([{ msgid: '10', revokeUid: '' }]);
    const recallTs = (await db.listRecalls('group', '777'))[0]?.recallTs;
    const originalBody = sql.prepare(
      'SELECT "40800" AS body FROM group_msg_table WHERE "40001" = 10',
    );
    expect(originalBody.get()?.body).toEqual(original);

    const revoker = `u_${'x'.repeat(22)}`;
    update.run(
      body.encode({ elements: [{ elementType: 8, subType: 1, recallRevokeUid: revoker }] }),
      10,
    );
    update.run(unknown, 10);
    expect(await db.listRecalls('group', '777')).toMatchObject([
      { msgid: '10', revokeUid: revoker, recallTs },
    ]);
  });

  it('私聊与数据线标记合为一页查询，只探测一次表且保持会话和 ID 隔离', async () => {
    createFixture(true);
    const large = 7695126900078041334n;
    insertRow(10, 'c2c', 'u_peer', 10);
    insertRow(large, 'dataline', 'u_peer', 30);
    insertRow(12, 'group', 'u_peer', 40);
    insertRow(13, 'c2c', 'u_other', 50);
    insertRow(14, 'c2c', 'u_peer', 60);
    const execute = vi.spyOn(nt, 'executeSql');
    const rows = await db.listRecalls(['c2c', 'dataline', 'c2c'], 'u_peer', [10n, large, 12n, 13n]);
    expect(rows.map((row) => row.msgid)).toEqual([String(large), '10']);
    expect(execute).toHaveBeenCalledTimes(2);
    execute.mockClear();
    expect(await db.listRecalls([], 'u_peer', [10n])).toEqual([]);
    expect(await db.listRecalls(['c2c', 'dataline'], 'u_peer', [])).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
  it('合并标记读取保留分批和全量顺序，缺表之后新建表仍可立即读取', async () => {
    createFixture(false);
    expect(await db.listRecalls(['c2c', 'dataline'], 'u_peer')).toEqual([]);
    fixtureDb(dbPath).exec(LOG_DDL);
    for (let i = 1; i <= 270; i++) insertRow(i, i % 2 ? 'c2c' : 'dataline', 'u_peer', i);
    const ids = Array.from({ length: 270 }, (_, i) => BigInt(i + 1));
    const execute = vi.spyOn(nt, 'executeSql');
    const rows = await db.listRecalls(['c2c', 'dataline'], 'u_peer', [...ids, 1n]);
    expect(rows).toHaveLength(ids.length);
    expect(rows[0]?.msgid).toBe('270');
    expect(rows.at(-1)?.msgid).toBe('1');
    expect(execute).toHaveBeenCalledTimes(3);
    expect(await db.listRecalls(['c2c', 'dataline'], 'u_peer')).toEqual(rows);
  });
  it('表不存在时三处读法都优雅返回空（用户从没开过防撤回）', async () => {
    createFixture(false);

    expect(await db.listRecalls('group', '777')).toEqual([]);
    expect(await db.recallSummaries()).toEqual([]);
    expect(await db.latestRecallBaseline()).toEqual({ recallTs: 0, seen: new Set() });
    expect(await db.listRecallsSince({ recallTs: 0 })).toEqual([]);
  });

  it('listRecalls 按会话 + 表过滤，最新撤回在前', async () => {
    createFixture(true);
    insertRow(10, 'group', '777', 1700000010);
    insertRow(11, 'group', '777', 1700000030);
    insertRow(12, 'group', '888', 1700000099);
    insertRow(13, 'c2c', 'u_peer', 1700000200);

    const rows = await db.listRecalls('group', '777');
    expect(rows.map((r) => r.msgid)).toEqual(['11', '10']);
    expect(rows[0]).toMatchObject({
      conv: '777',
      kind: 'group',
      senderUid: 'u_sender',
      revokeUid: 'u_revoker',
      origSeq: '12',
      recallTs: 1700000030,
    });
  });

  it('消息页只查询当前页 ID，保留 64 位精度、缺表和跨表隔离', async () => {
    createFixture(true);
    const large = 7695126900078041334n;
    insertRow(10, 'group', '777', 10);
    insertRow(11, 'group', '777', 11);
    insertRow(large, 'group', '777', 12);
    insertRow(12, 'group', '888', 13);
    insertRow(13, 'dataline', '777', 14);
    expect(
      (await db.listRecalls('group', '777', [10n, large, 12n, 13n])).map((row) => row.msgid),
    ).toEqual([String(large), '10']);
    expect(await db.listRecalls('group', '777', [])).toEqual([]);
  });

  it('recallSummaries 按会话汇总计数 + 最近一次时间，最新活动在前', async () => {
    createFixture(true);
    insertRow(10, 'group', '777', 1700000010);
    insertRow(11, 'group', '777', 1700000030);
    insertRow(12, 'c2c', 'u_peer', 1700000200);

    const summaries = await db.recallSummaries();
    expect(summaries).toEqual([
      { kind: 'c2c', conv: 'u_peer', count: 1, lastTs: 1700000200 },
      { kind: 'group', conv: '777', count: 2, lastTs: 1700000030 },
    ]);
  });

  it('按撤回时间分页，后撤回的原消息 ID 可以更小', async () => {
    createFixture(true);
    insertRow(10, 'group', '777', 1700000010);
    insertRow(20, 'c2c', 'u_peer', 1700000020);

    const baseline = await db.latestRecallBaseline();
    expect(baseline).toEqual({ recallTs: 1700000020, seen: new Set(['20']) });
    insertRow(5, 'group', '777', 1700000020);
    insertRow(1, 'group', '777', 1700000030);
    expect(
      (await db.listRecallsSince({ recallTs: baseline.recallTs }, 1)).map((r) => r.msgid),
    ).toEqual(['5']);
    expect(
      (await db.listRecallsSince({ recallTs: 1700000020, msgId: 5n })).map((r) => r.msgid),
    ).toEqual(['20', '1']);
  });

  it('msgid 超过 2^53 时游标保持精确，同一行不会被反复命中（重复弹通知回归）', async () => {
    createFixture(true);
    // 真实 QQ 40001 就在 7.7e18 量级，远超 Number.MAX_SAFE_INTEGER（2^53）。
    // Number(msgid) 会向下取整，导致候选游标永远小于真实 msgid，`msgid > cursor`
    // 会把同一行反复读出来 → 同一条撤回过一会儿弹一次。这里锁死 bigint 精度。
    const big = 7695126900078041334n;
    expect(big > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    insertRow(big, 'c2c', 'u_LKt3AdAIMP-CUfn6ydzDzw', 1700000500);

    expect(await db.latestRecallBaseline()).toEqual({
      recallTs: 1700000500,
      seen: new Set([String(big)]),
    });
    const bigger = big + 1n;
    insertRow(bigger, 'c2c', 'u_LKt3AdAIMP-CUfn6ydzDzw', 1700000500);
    expect(
      (await db.listRecallsSince({ recallTs: 1700000500, msgId: big })).map((r) => r.msgid),
    ).toEqual([String(bigger)]);
    expect(await db.listRecallsSince({ recallTs: 1700000500, msgId: bigger })).toEqual([]);
  });
});
