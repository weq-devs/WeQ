/**
 * QQ-style delete/restore round-trip — the offline twin of the old
 * `tools/mutate/msgtype_roundtrip.ts` + `tools/dump_msg_by_id.ts` knowledge.
 *
 * QQ (and WeQ, which mirrors it) marks a recalled/deleted message by rewriting
 * 40011/40012 to (1,1) IN PLACE while leaving the 40800 body untouched. This
 * drives the real `GroupMsgDb` primitives over the testkit sqlite stub:
 *
 *   readMsgType → writeMsgType(orig) → writeMsgType(1,1) → readMsgType
 *
 * and asserts the body survives every write byte-for-byte.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GroupMsgDb } from '@weq/db';
import { closeAllFixtureDbs, createSqliteStub, fixtureDb } from '@weq/testkit';

const MSG_ID = 7662841583143182782n;
const ORIG = { msgType: 2n, subType: 16n };
const DELETED = { msgType: 1n, subType: 1n };
const BODY = new TextEncoder().encode('40800-body-must-survive-<text>你好</text>');

let dir: string;
let dbPath: string;
let db: GroupMsgDb;

afterEach(() => {
  db.close();
  closeAllFixtureDbs();
  rmSync(dir, { recursive: true, force: true });
});

function createFixture(): void {
  dir = mkdtempSync(join(tmpdir(), 'weq-msgtype-'));
  dbPath = join(dir, 'nt_msg.db');
  const sql = fixtureDb(dbPath);
  sql.exec(`
    CREATE TABLE group_msg_table (
      "40001" INTEGER, "40002" INTEGER, "40003" INTEGER, "40011" INTEGER,
      "40012" INTEGER, "40020" TEXT, "40027" TEXT, "40033" INTEGER,
      "40050" INTEGER, "40062" BLOB, "40800" BLOB, "40801" BLOB
    )
  `);
  sql
    .prepare(
      `INSERT INTO group_msg_table
         ("40001","40002","40003","40011","40012","40020","40027","40033","40050","40062","40800","40801")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      MSG_ID,
      42n,
      7n,
      ORIG.msgType,
      ORIG.subType,
      'u_sender',
      '777',
      10001n,
      1700000000n,
      null,
      BODY,
      null,
    );

  // key+algo set on purpose: exercises the *WithKey binding variants the
  // encrypted production path goes through (the stub ignores the key).
  db = new GroupMsgDb(createSqliteStub(), {
    dbPath,
    key: 'fixture-key',
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
}

describe('GroupMsgDb delete/restore primitives (offline fixture)', () => {
  it('read → restore → delete round-trip keeps the 40800 body untouched', async () => {
    createFixture();

    const before = await db.readMsgType(MSG_ID);
    expect(before).toEqual({ msgType: ORIG.msgType, subType: ORIG.subType });

    // Restore to originals.
    expect(await db.writeMsgType(MSG_ID, ORIG.msgType, ORIG.subType)).toBe(1);
    expect(await db.readMsgType(MSG_ID)).toEqual({ msgType: ORIG.msgType, subType: ORIG.subType });

    // Delete: (1,1) — the QQ deleted fingerprint.
    expect(await db.writeMsgType(MSG_ID, DELETED.msgType, DELETED.subType)).toBe(1);
    expect(await db.readMsgType(MSG_ID)).toEqual({
      msgType: DELETED.msgType,
      subType: DELETED.subType,
    });

    // Body untouched by all writes.
    const bodyAfter = await db.getMsgBody(MSG_ID);
    expect(bodyAfter).not.toBeNull();
    expect(Buffer.from(bodyAfter!).equals(Buffer.from(BODY))).toBe(true);

    // listByMsgIds finds the row regardless of deleted state.
    const rows = await db.listByMsgIds([MSG_ID]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.msgSeq).toBe(7n);
  });

  it('readMsgType returns null for unknown msgId', async () => {
    createFixture();
    expect(await db.readMsgType(12345678901234n)).toBeNull();
  });
});
