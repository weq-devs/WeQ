/**
 * Round-trip test for the QQ-style delete/restore primitives on GroupMsgDb:
 * readMsgType → writeMsgType(orig) → readMsgType → writeMsgType(1,1) → readMsgType.
 *
 * Uses the known QQ-deleted probe message (msgId 7662841583143182782, original
 * 40011/40012 = 2/16, currently 1/1 after a real QQ delete) so the row ends in
 * exactly the state it started in. The 40800 body must be untouched throughout.
 *
 * Run:  pnpm tsx ./packages/db/test/msgtype_roundtrip.ts
 */

import { loadNative } from '@weq/native';
import { GroupMsgDb } from '../src/msg/group';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

const MSG_ID = 7662841583143182782n;
const ORIG = { msgType: 2n, subType: 16n };
const DELETED = { msgType: 1n, subType: 1n };

function fmt(v: { msgType: bigint; subType: bigint } | null): string {
  return v ? `(40011=${v.msgType}, 40012=${v.subType})` : '(row not found)';
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    const before = await db.readMsgType(MSG_ID);
    const bodyBefore = await db.getMsgBody(MSG_ID);
    console.log(`[roundtrip] start        ${fmt(before)}  body=${bodyBefore?.byteLength ?? 'null'}B`);
    if (!before) throw new Error('probe message not found in group_msg_table');

    // 1) restore to the known originals (2,16)
    const n1 = await db.writeMsgType(MSG_ID, ORIG.msgType, ORIG.subType);
    const afterRestore = await db.readMsgType(MSG_ID);
    console.log(`[roundtrip] restore→orig ${fmt(afterRestore)}  affected=${n1}`);
    if (afterRestore?.msgType !== ORIG.msgType || afterRestore?.subType !== ORIG.subType) {
      throw new Error('restore write did not land');
    }

    // 2) delete again (1,1) — back to the exact starting state
    const n2 = await db.writeMsgType(MSG_ID, DELETED.msgType, DELETED.subType);
    const afterDelete = await db.readMsgType(MSG_ID);
    const bodyAfter = await db.getMsgBody(MSG_ID);
    console.log(`[roundtrip] delete→(1,1) ${fmt(afterDelete)}  affected=${n2}  body=${bodyAfter?.byteLength ?? 'null'}B`);
    if (afterDelete?.msgType !== DELETED.msgType || afterDelete?.subType !== DELETED.subType) {
      throw new Error('delete write did not land');
    }
    if ((bodyBefore?.byteLength ?? -1) !== (bodyAfter?.byteLength ?? -2)) {
      throw new Error('40800 body changed size — must be untouched');
    }

    // 3) listByMsgIds finds the row by id regardless of deleted state
    const rows = await db.listByMsgIds([MSG_ID]);
    console.log(`[roundtrip] listByMsgIds → ${rows.length} row(s), sender=${rows[0]?.senderUin}`);
    if (rows.length !== 1) throw new Error('listByMsgIds miss');

    console.log('[roundtrip] PASS — row ended in its starting state');
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('[roundtrip] FAILED:', e);
  process.exit(1);
});
