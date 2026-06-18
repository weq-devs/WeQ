/**
 * Inspect a single message that contains a `reply` element.
 *
 * Goal: confirm the real shape of `origElements` (the snapshot of the quoted
 * message) so the desktop reply renderer maps it correctly. We dump:
 *   1. the raw decoded Element[] (codec `kind` form),
 *   2. each origElement's keys (un-decoded ReplyElementWire),
 *   3. origElements after decodeElement() + toRenderElements() ({type,data}).
 *
 * Run: pnpm --filter @weq/service exec tsx test/reply_element.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '@weq/db';
import { ProtoMsg, decodeElement } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { toRenderElements } from '../src/account/msg_view';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\nt_msg.db`;

const TARGET_ROWID = 7623134680434489438n;

const bodyCodec = new ProtoMsg(MsgBody);

/** JSON.stringify that survives bigint / Uint8Array. */
function pretty(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (v instanceof Uint8Array) return `<bytes:${v.length}>`;
      return v;
    },
    2,
  );
}

function decodeBodyBlob(blob: unknown): unknown[] {
  if (!(blob instanceof Uint8Array)) return [];
  const decoded = bodyCodec.decode(sanitizeBytes(blob, MsgBody));
  return decoded.elements ?? [];
}

async function dumpFromTable(db: QqDb, table: string): Promise<boolean> {
  const rows = await db.query(
    `SELECT rowid, "40001", "40003", "40800" FROM ${table} WHERE rowid = ? OR "40001" = ? LIMIT 1`,
    [TARGET_ROWID, TARGET_ROWID],
  );
  if (rows.length === 0) return false;

  const row = rows[0]!;
  console.log(`\n=== Found in ${table} ===`);
  console.log(`rowid=${row[0]}  msgId(40001)=${row[1]}  msgSeq(40003)=${row[2]}`);

  const wireElements = decodeBodyBlob(row[3]);
  const elements = wireElements.map((w) => decodeElement(w as never));

  console.log(`\n--- decoded Element[] (codec kind form) ---`);
  console.log(pretty(elements.map((e) => ({ kind: (e as { kind?: string }).kind }))));

  const replyWire = wireElements.find(
    (_w, i) => (elements[i] as { kind?: string }).kind === 'reply',
  ) as { origElements?: unknown[] } | undefined;
  const reply = elements.find((e) => (e as { kind?: string }).kind === 'reply');

  if (!reply || !replyWire) {
    console.log('\n[!] No reply element in this message.');
    return true;
  }

  console.log(`\n--- reply element top-level keys ---`);
  console.log(Object.keys(reply as object).join(', '));

  const r = reply as Record<string, unknown>;
  console.log(`\n--- reply seq/id candidates (this msg seq=40003=${row[2]}) ---`);
  console.log(`origMsgSeq   = ${r.origMsgSeq}`);
  console.log(`origMsgIndex = ${r.origMsgIndex}`);
  console.log(`origMsgId    = ${r.origMsgId}`);
  console.log(`origMsgTime  = ${r.origMsgTime}`);

  const origElements = Array.isArray(replyWire.origElements) ? replyWire.origElements : [];
  console.log(`\n--- origElements: ${origElements.length} item(s), RAW (un-decoded wire) ---`);
  origElements.forEach((el, i) => {
    console.log(`[${i}] keys: ${Object.keys(el as object).join(', ')}`);
    console.log(pretty(el));
  });

  console.log(`\n--- origElements AFTER decodeElement() + toRenderElements() ({type,data}) ---`);
  const renderOrig = toRenderElements(origElements.map((el) => decodeElement(el as never)));
  console.log(pretty(renderOrig));

  console.log(`\n--- full message via toRenderElements(): reply.data.origElements (the fix) ---`);
  const rendered = toRenderElements(elements as never[]);
  const renderReply = rendered.find((r) => r.type === 'reply') as
    | { data?: { origMsgIndex?: number; origElements?: unknown[] } }
    | undefined;
  console.log(`origMsgIndex (jump seq) = ${renderReply?.data?.origMsgIndex}`);
  console.log(pretty(renderReply?.data?.origElements));

  return true;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    const inGroup = await dumpFromTable(db, 'group_msg_table');
    if (!inGroup) {
      const inC2c = await dumpFromTable(db, 'c2c_msg_table');
      if (!inC2c) console.log(`[!] rowid ${TARGET_ROWID} not found in either table.`);
    }
  } catch (err) {
    console.error('[test:reply] Failed:', err);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('[test:reply] failed:', e);
  process.exit(1);
});
