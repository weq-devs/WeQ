/**
 * Live end-to-end check of the private-file URL fix: pull the real FILE element
 * from the DB row and resolve its download URL via the *fixed*
 * `getPrivateFileUrlFromElement` (now uses transferFlag45504 as fileHash).
 *
 * Needs a running, logged-in QQ for the test account (OIDB call).
 * Run: pnpm --filter @weq/service exec tsx test/verify_c2c_file_url.ts
 */

import assert from 'node:assert/strict';
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { QqDb } from '@weq/db';
import { decodeElement } from '@weq/codec';
import { MediaUrlService, type MediaElement } from '../src/account/media_url';
import { ProtoMsg } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\nt_msg.db`;
const SELF_UID = 'u_mGIBTBW7gF4Wocw8zapc6w';
const TARGET_MSGID = 7654987674703340593n;

const bodyCodec = new ProtoMsg(MsgBody);

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('no running QQ.exe');
  const pid = pids[0]!;
  console.log(`[verify-c2c-file] pid=${pid} uin=${nt.probeQqLoginInfo(pid)?.uin}`);
  await nt.injectAndGetStatusEmbedded(pid);

  const db = new QqDb(nt, { dbPath: DB_PATH, key: KEY, algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } });
  let fileEl: MediaElement;
  try {
    const rows = await db.query(`SELECT "40800" FROM c2c_msg_table WHERE "40001" = ? LIMIT 1`, [TARGET_MSGID]);
    const blob = rows[0]?.[0];
    if (!(blob instanceof Uint8Array)) throw new Error('row/body not found');
    const elements = (bodyCodec.decode(sanitizeBytes(blob, MsgBody)).elements ?? []).map((w) => decodeElement(w as never));
    const found = elements.find((e) => (e as { kind?: string }).kind === 'file');
    if (!found) throw new Error('no file element');
    fileEl = found as unknown as MediaElement;
  } finally {
    db.close();
  }

  const session = { context: { uin: UIN }, uidMap: { uidByUin: () => SELF_UID } } as unknown as AccountSession;
  const svc = new MediaUrlService(nt, session, () => pid);

  console.log(`[verify-c2c-file] resolving URL via getPrivateFileUrlFromElement…`);
  const url = await svc.getPrivateFileUrlFromElement(fileEl);
  console.log(`[verify-c2c-file] URL: ${url}`);
  assert.match(url, /^https?:\/\/\S+$/);
  console.log('[verify-c2c-file] PASS — resolved a real download URL');
}

main().catch((err) => {
  console.error('[verify-c2c-file] FAILED:', err);
  process.exit(1);
});
