/**
 * Live check of private-video URL resolution: pull the real VIDEO element from
 * the DB row and resolve its download URL via getPrivateVideoUrlFromElement.
 * Needs a running, logged-in QQ for the test account.
 * Run: pnpm --filter @weq/service exec tsx test/verify_c2c_video_url.ts
 */

import assert from 'node:assert/strict';
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { QqDb } from '@weq/db';
import { decodeElement, ProtoMsg } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { MediaUrlService, mediaNodeFromElement, type MediaElement } from '../src/account/media_url';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\nt_msg.db`;
const SELF_UID = 'u_mGIBTBW7gF4Wocw8zapc6w';
const TARGET_MSGID = 7654823310271900328n;

const bodyCodec = new ProtoMsg(MsgBody);

function pretty(v: unknown): string {
  return JSON.stringify(
    v,
    (_k, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? `<bytes:${x.length}>` : x),
    2,
  );
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const pid = nt.getQqProcesses()[0];
  if (!pid) throw new Error('no running QQ.exe');
  console.log(`[verify-c2c-video] pid=${pid} uin=${nt.probeQqLoginInfo(pid)?.uin}`);
  await nt.injectAndGetStatusEmbedded(pid);

  const db = new QqDb(nt, { dbPath: DB_PATH, key: KEY, algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } });
  let videoEl: MediaElement;
  try {
    const rows = await db.query(`SELECT "40021","40800" FROM c2c_msg_table WHERE "40001" = ? LIMIT 1`, [TARGET_MSGID]);
    const blob = rows[0]?.[1];
    if (!(blob instanceof Uint8Array)) throw new Error('row/body not found');
    console.log(`[verify-c2c-video] peer(40021)=${rows[0]?.[0]}`);
    const elements = (bodyCodec.decode(sanitizeBytes(blob, MsgBody)).elements ?? []).map((w) => decodeElement(w as never));
    console.log(`[verify-c2c-video] kinds = ${elements.map((e) => (e as { kind?: string }).kind).join(', ')}`);
    const found = elements.find((e) => (e as { kind?: string }).kind === 'video');
    if (!found) throw new Error('no video element');
    videoEl = found as unknown as MediaElement;
  } finally {
    db.close();
  }

  console.log(`\n--- mediaNodeFromElement(videoEl) ---`);
  console.log(pretty(mediaNodeFromElement(videoEl)));

  const session = { context: { uin: UIN }, uidMap: { uidByUin: () => SELF_UID } } as unknown as AccountSession;
  const svc = new MediaUrlService(nt, session, () => pid);

  console.log(`\n[verify-c2c-video] resolving URL via getPrivateVideoUrlFromElement…`);
  const url = await svc.getPrivateVideoUrlFromElement(videoEl);
  console.log(`[verify-c2c-video] URL: ${url}`);
  assert.match(url, /^https?:\/\/\S+$/);
  console.log('[verify-c2c-video] PASS — resolved a real download URL');
}

main().catch((err) => {
  console.error('[verify-c2c-video] FAILED:', err);
  process.exit(1);
});
