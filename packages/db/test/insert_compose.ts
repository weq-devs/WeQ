/**
 * End-to-end test of the compose → encode → append pipeline (the exact logic the
 * MsgService insert path runs), against a real nt_msg.db.
 *
 *   validateComposeMessage → encodeElement → MsgBody.encode → GroupMsgDb.appendMessage
 *
 * Inserts a text message into a target group, then reads the group's newest
 * message back and decodes it to confirm the round-trip.
 *
 * ⚠️ WRITES to the live DB. Back up first. Run: pnpm tsx ./packages/db/test/insert_compose.ts
 */

import { loadNative } from '@weq/native';
import { ProtoMsg, encodeElement, validateComposeMessage } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { GroupMsgDb } from '../src/msg/group';
import type { AppendMsgFields } from '../src/msg/append';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const GROUP_CODE = '1090396070';

const bodyCodec = new ProtoMsg(MsgBody);

function localMidnight(sec: bigint): bigint {
  const d = new Date(Number(sec) * 1000);
  return BigInt(Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000));
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[insert-compose] group ${GROUP_CODE}`);

  // Reuse the last message's sender as our author (a guaranteed-valid uid/uin).
  const [last] = await db.listLatest(GROUP_CODE, 1);
  if (!last) throw new Error('group has no message to clone');
  console.log(`last: msgSeq=${last.msgSeq}n sender=${last.senderUin}n`);

  // 1) author + validate (also derives msgType).
  const text = `【WeQ compose test】seq→${last.msgSeq + 1n}`;
  const parsed = validateComposeMessage([{ kind: 'text', textContent: text }]);
  if (!parsed.ok) throw new Error(`validate failed: ${parsed.error}`);
  console.log(`validated: msgType=${parsed.msgType} (expect 2, no reply)`);

  // 2) encode + assemble fields (mirrors MsgService.buildAppendFields).
  const sendTime = BigInt(Math.floor(Date.now() / 1000));
  const fields: AppendMsgFields = {
    senderUid: last.senderUid,
    senderUin: last.senderUin,
    msgType: parsed.msgType,
    sendTime,
    dayTimestamp: localMidnight(sendTime),
    body: bodyCodec.encode({ elements: parsed.elements.map(encodeElement) }),
  };

  // 3) append.
  const res = await db.appendMessage(GROUP_CODE, fields);
  if (!res) throw new Error('appendMessage returned null');
  console.log(`inserted: msgId=${res.msgId}n msgSeq=${res.msgSeq}n`);

  // 4) read back + verify.
  const now = (await db.listLatest(GROUP_CODE, 1))[0];
  if (!now) throw new Error('readback failed');
  const el = now.elements[0];
  const gotText = el?.kind === 'text' ? el.textContent : `(kind=${el?.kind})`;
  console.log('\nreadback newest:');
  console.log(`  msgId    = ${now.msgId}n  (match: ${now.msgId === res.msgId})`);
  console.log(`  msgSeq   = ${now.msgSeq}n  (= last+1: ${now.msgSeq === last.msgSeq + 1n})`);
  console.log(`  sendTime = ${now.sendTime}n (= now: ${now.sendTime === sendTime})`);
  console.log(`  sender   = ${now.senderUin}n`);
  console.log(`  text     = ${JSON.stringify(gotText)}  (match: ${gotText === text})`);

  const ok = now.msgId === res.msgId && now.msgSeq === last.msgSeq + 1n && gotText === text;
  console.log(`\n[insert-compose] ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
  db.close();
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('[insert-compose] failed:', e);
  process.exit(1);
});
