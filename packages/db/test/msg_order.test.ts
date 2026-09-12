/**
 * Gray-tip ordering regression — the offline twin of the old
 * `tools/verify_msg_order.ts` probe, running the REAL `GroupMsgDb` accessors
 * against a plain-SQLite fixture via the testkit sqlite stub.
 *
 * What it locks in (see GroupMsgDb.ORDER_NEWEST_FIRST):
 *  - `listLatest` orders by (40003, 40050, 40001) — a same-seq run (gray tips
 *    share the seq of the message they hang off) must be internally
 *    time-ordered, never shuffled by the random 40002 tie-break;
 *  - repeated reads agree (stable);
 *  - `listBefore` / `listAfter` paging around a pivot never overlaps.
 *
 * Insertion order in the fixture is deliberately scrambled, so a regression to
 * index/rowid order fails the test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupMsgDb } from '@weq/db';
import type { GroupMsg } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const GROUP = '777';

let dir: string;
let dbPath: string;
let db: GroupMsgDb;

afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

/** One message row. Times are unix seconds. */
function msg(opts: {
  msgId: number;
  msgSeq: number;
  sendTime: number;
  /** Scrambled tie-break column, as QQ writes it. */
  tie: number;
  msgType?: number;
  subType?: number;
}): unknown[] {
  return [
    BigInt(opts.msgId), // 40001
    BigInt(opts.tie), // 40002
    BigInt(opts.msgSeq), // 40003
    BigInt(opts.msgType ?? 2), // 40011
    BigInt(opts.subType ?? 16), // 40012
    'u_sender', // 40020
    GROUP, // 40027
    10001n, // 40033
    BigInt(opts.sendTime), // 40050
    null, // 40062
    null, // 40800
    null, // 40801
  ];
}

function createFixture(): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-msg-order-'));
  dbPath = join(dir, 'nt_msg.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`
    CREATE TABLE group_msg_table (
      "40001" INTEGER, "40002" INTEGER, "40003" INTEGER, "40011" INTEGER,
      "40012" INTEGER, "40020" TEXT, "40027" TEXT, "40033" INTEGER,
      "40050" INTEGER, "40062" BLOB, "40800" BLOB, "40801" BLOB
    )
  `);
  const ins = sql.prepare(
    `INSERT INTO group_msg_table
       ("40001","40002","40003","40011","40012","40020","40027","40033","40050","40062","40800","40801")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  ins.setReadBigInts(true);

  // A same-seq run at seq=12 (gray tip + two tips around a message): times go
  // forward but the 40002 tie-breaks and INSERTION order are scrambled, so the
  // old "index order" bug would shuffle them.
  const rows = [
    msg({ msgId: 1, msgSeq: 10, sendTime: 1000, tie: 900 }),
    msg({ msgId: 2, msgSeq: 11, sendTime: 1010, tie: 100 }),
    msg({ msgId: 3, msgSeq: 12, sendTime: 1020, tie: 700 }),
    msg({ msgId: 4, msgSeq: 12, sendTime: 1021, tie: 10 }), // tip, newest in run
    msg({ msgId: 5, msgSeq: 12, sendTime: 1022, tie: 500 }), // tip, newest of all
    msg({ msgId: 6, msgSeq: 13, sendTime: 1030, tie: 300 }),
    msg({ msgId: 7, msgSeq: 14, sendTime: 1040, tie: 800 }),
    { __otherGroup: true, msgId: 8, msgSeq: 1, sendTime: 1, tie: 1 },
  ];
  for (const r of rows) {
    if ('__otherGroup' in r) {
      ins.run(BigInt(r.msgId), BigInt(r.tie), 1n, 2n, 16n, 'u_x', '999', 1n, 1n, null, null, null);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ins.run(...(r as unknown[]));
    }
  }

  db = new GroupMsgDb(createSqliteStub(), { dbPath });
}

/** Adjacent same-seq pairs where sendTime steps backwards. */
function sameSeqInversions(rows: GroupMsg[]): Array<[GroupMsg, GroupMsg]> {
  const bad: Array<[GroupMsg, GroupMsg]> = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1]!;
    const b = rows[i]!;
    if (a.msgSeq === b.msgSeq && b.sendTime < a.sendTime) bad.push([a, b]);
  }
  return bad;
}

describe('GroupMsgDb ordering (offline fixture)', () => {
  it('listLatest orders same-seq runs by time, newest-first overall', async () => {
    createFixture();

    const latest = await db.listLatest(GROUP, 40);
    expect(latest).toHaveLength(7);

    // Newest-first by seq.
    const seqs = latest.map((m) => m.msgSeq);
    const sorted = [...seqs].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    expect(seqs).toEqual(sorted);

    // What the renderer shows: reversed → oldest-first; same-seq runs must be
    // internally time-ordered (the actual gray-tip bug).
    const rendered = [...latest].reverse();
    expect(sameSeqInversions(rendered)).toHaveLength(0);

    // The seq=12 run lands in insertion-independent time order: 1020,1021,1022.
    const run = rendered.filter((m) => m.msgSeq === 12n).map((m) => Number(m.sendTime));
    expect(run).toEqual([1020, 1021, 1022]);

    // Bodies decode to empty (no 40800), not throw.
    expect(rendered[0]!.elements).toEqual([]);
  });

  it('listLatest is stable across reads', async () => {
    createFixture();

    const a = await db.listLatest(GROUP, 40);
    const b = await db.listLatest(GROUP, 40);
    expect(b.map((m) => String(m.msgId))).toEqual(a.map((m) => String(m.msgId)));
  });

  it('listBefore/listAfter paging around a pivot never overlaps', async () => {
    createFixture();

    const latest = await db.listLatest(GROUP, 40);
    const rendered = [...latest].reverse();
    const pivot = rendered[Math.floor(rendered.length / 2)]!;

    const before = await db.listBefore(GROUP, pivot.msgSeq, 40);
    const after = await db.listAfter(GROUP, pivot.msgSeq, 40);

    const beforeIds = new Set(before.map((m) => String(m.msgId)));
    const afterIds = new Set(after.map((m) => String(m.msgId)));
    // Strictly disjoint (the original probe's assertion) — same-seq siblings of
    // the pivot are in neither window by design (both windows are exclusive).
    for (const id of beforeIds) expect(afterIds.has(id)).toBe(false);

    const all = new Set(latest.map((m) => String(m.msgId)));
    all.delete(String(pivot.msgId));
    for (const id of beforeIds) expect(all.has(id)).toBe(true);
    for (const id of afterIds) expect(all.has(id)).toBe(true);

    expect(sameSeqInversions([...before].reverse())).toHaveLength(0);
    expect(sameSeqInversions(after)).toHaveLength(0);
  });
});
