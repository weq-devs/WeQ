/**
 * Inspect one private-chat (c2c) FILE message's raw decoded element, to verify
 * the DB carries the fields our export download path expects.
 *
 * Why: private-file media completion resolves a download URL via
 * `MediaUrlService.getPrivateFileUrlFromElement`, which needs `fileToken`
 * (fileId) + a file hash from `md5Bytes2` (preferred) / `md5` / `md5Bytes`. If
 * any are missing on the real row, the resolve throws and the file counts as a
 * media failure. This dumps every field so we can compare against expectations.
 *
 * Run: pnpm --filter @weq/service exec tsx test/inspect_c2c_file.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '@weq/db';
import { ProtoMsg, decodeElement } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { mediaNodeFromElement, type MediaElement } from '../src/account/media_url';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\nt_msg.db`;

/** The private file message to inspect (msgId = column 40001). */
const TARGET_MSGID = 7654987674703340593n;

const bodyCodec = new ProtoMsg(MsgBody);

/** JSON.stringify that survives bigint / Uint8Array (bytes → text/hex + length). */
function pretty(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === 'bigint') return `${v}n`;
      if (v instanceof Uint8Array) {
        const text = new TextDecoder().decode(v);
        const printable = /^[\x20-\x7e]*$/.test(text);
        let hex = '';
        for (let i = 0; i < Math.min(v.length, 64); i++) hex += v[i]!.toString(16).padStart(2, '0');
        return `<bytes len=${v.length}${printable && text ? ` text="${text}"` : ''} hex=${hex}${v.length > 64 ? '…' : ''}>`;
      }
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

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    const rows = await db.query(
      `SELECT rowid, "40001", "40003", "40020", "40021", "40050", "40800"
         FROM c2c_msg_table WHERE "40001" = ? LIMIT 1`,
      [TARGET_MSGID],
    );
    if (rows.length === 0) {
      console.log(`[!] msgId ${TARGET_MSGID} not found in c2c_msg_table.`);
      return;
    }
    const row = rows[0]!;
    console.log(`\n=== c2c_msg_table row ===`);
    console.log(`rowid=${row[0]}  msgId(40001)=${row[1]}  seq(40003)=${row[2]}`);
    console.log(`senderUid(40020)=${row[3]}  targetUid(40021)=${row[4]}  sendTime(40050)=${row[5]}`);

    const wire = decodeBodyBlob(row[6]);
    const elements = wire.map((w) => decodeElement(w as never));
    console.log(`\n--- elements: ${elements.length}, kinds = ${elements.map((e) => (e as { kind?: string }).kind).join(', ')}`);

    const fileEl = elements.find((e) => (e as { kind?: string }).kind === 'file') as
      | Record<string, unknown>
      | undefined;
    if (!fileEl) {
      console.log('\n[!] No file element in this message.');
      return;
    }

    console.log(`\n--- file element: ALL fields ---`);
    console.log(pretty(fileEl));

    // The exact inputs getPrivateFileUrlFromElement uses.
    const fe = fileEl as unknown as {
      fileToken?: string;
      fileName?: string;
      fileSize?: number;
      md5?: string;
      md5Bytes?: Uint8Array;
      md5Bytes2?: Uint8Array;
      contentHash?: Uint8Array;
    };
    const decode = (b?: Uint8Array): string => (b?.length ? new TextDecoder().decode(b) : '');
    console.log(`\n--- private-file URL resolve inputs ---`);
    console.log(`fileToken (fileId)   = ${JSON.stringify(fe.fileToken)}`);
    console.log(`fileName             = ${JSON.stringify(fe.fileName)}`);
    console.log(`fileSize             = ${fe.fileSize}`);
    console.log(`md5 (string)         = ${JSON.stringify(fe.md5)}`);
    console.log(`md5Bytes len         = ${fe.md5Bytes?.length ?? 0}`);
    console.log(`md5Bytes2 len        = ${fe.md5Bytes2?.length ?? 0}  text="${decode(fe.md5Bytes2)}"`);
    console.log(`contentHash len      = ${fe.contentHash?.length ?? 0}`);
    // What MediaUrlService.getPrivateFileUrlFromElement would pick as fileHash:
    const fileHash = decode(fe.md5Bytes2) || fe.md5 || '';
    console.log(`→ chosen fileHash    = ${JSON.stringify(fileHash)}  (empty ⇒ resolve throws)`);

    console.log(`\n--- mediaNodeFromElement(fileEl) ---`);
    console.log(pretty(mediaNodeFromElement(fileEl as unknown as MediaElement)));
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[inspect-c2c-file] fatal:', err);
  process.exit(1);
});
