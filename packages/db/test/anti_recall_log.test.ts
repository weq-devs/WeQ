/**
 * 防撤回记录表的读侧 —— `weq_recall_log` 是触发器写入、WeQ 读出来展示的表。
 *
 * 三个读法各自服务一处 UI / 逻辑：
 *   • listRecalls          → 某个会话的撤回列表（撤回列表面板）
 *   • recallSummaries      → 有撤回记录的会话目录（「更多 → 防撤回 → 记录」页）
 *   • latestRecallCursor / listRecallsAfter → 撤回通知监听器的增量游标
 *
 * 最要紧的行为是**表还没建**（用户从没开过防撤回）时必须优雅返回空，而不是抛
 * "no such table" —— 触发器第一次安装时才会建表。这里用 testkit 的 sqlite stub
 * 覆盖这条路径 + 正常读写路径。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  db = new AntiRecallDb(createSqliteStub(), { dbPath, key: 'fixture-key' });
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
  it('表不存在时三处读法都优雅返回空（用户从没开过防撤回）', async () => {
    createFixture(false);

    expect(await db.listRecalls('group', '777')).toEqual([]);
    expect(await db.recallSummaries()).toEqual([]);
    expect(await db.latestRecallCursor()).toBe(0n);
    expect(await db.listRecallsAfter(0n)).toEqual([]);
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

  it('latestRecallCursor + listRecallsAfter 按 msgid 增量推进（通知监听用）', async () => {
    createFixture(true);
    insertRow(10, 'group', '777', 1700000010);
    insertRow(20, 'c2c', 'u_peer', 1700000020);

    expect(await db.latestRecallCursor()).toBe(20n);
    // 基线之后的才是「本次运行新出现的撤回」—— 基线本身不该被重放。
    expect(await db.listRecallsAfter(20n)).toEqual([]);

    insertRow(30, 'group', '777', 1700000030);
    const fresh = await db.listRecallsAfter(20n);
    expect(fresh.map((r) => r.msgid)).toEqual(['30']);

    // 分页上限生效，且老的在前（游标只往后走）。
    insertRow(40, 'group', '777', 1700000040);
    expect((await db.listRecallsAfter(20n, 1)).map((r) => r.msgid)).toEqual(['30']);
    expect((await db.listRecallsAfter(30n)).map((r) => r.msgid)).toEqual(['40']);
  });

  it('msgid 超过 2^53 时游标保持精确，同一行不会被反复命中（重复弹通知回归）', async () => {
    createFixture(true);
    // 真实 QQ 40001 就在 7.7e18 量级，远超 Number.MAX_SAFE_INTEGER（2^53）。
    // Number(msgid) 会向下取整，导致候选游标永远小于真实 msgid，`msgid > cursor`
    // 会把同一行反复读出来 → 同一条撤回过一会儿弹一次。这里锁死 bigint 精度。
    const big = 7695126900078041334n;
    expect(big > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    insertRow(big, 'c2c', 'u_LKt3AdAIMP-CUfn6ydzDzw', 1700000500);

    expect(await db.latestRecallCursor()).toBe(big);
    // 基线（= 该行本身）之后没有新记录：绝不能把这一行当成「新撤回」重放。
    expect(await db.listRecallsAfter(big)).toEqual([]);
    expect(await db.listRecallsAfter(await db.latestRecallCursor())).toEqual([]);

    // 再插一条更大的，游标推进到它之后，老的仍不会重放。
    const bigger = big + 1000n;
    insertRow(bigger, 'c2c', 'u_LKt3AdAIMP-CUfn6ydzDzw', 1700000600);
    expect((await db.listRecallsAfter(big)).map((r) => r.msgid)).toEqual([bigger.toString()]);
    expect(await db.listRecallsAfter(bigger)).toEqual([]);
  });
});
