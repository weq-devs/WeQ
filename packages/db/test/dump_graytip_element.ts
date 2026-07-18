/**
 * Dump the fully-decoded elements (40800 body) of the crafted gray-tip message
 * 7737024164892267232, plus the raw BLOB as hex, so we can record the exact
 * element shape that renders as the desired 灰条.
 *
 * Run:  pnpm tsx packages/db/test/dump_graytip_element.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;
const MSG_ID = 7737024164892267232n;

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const rows = await db.query(
    `SELECT "40001","40003","40008","40011","40012","40013","40020","40050","40800"
       FROM group_msg_table WHERE "40001" = ? LIMIT 1`,
    [MSG_ID],
  );
  if (!rows.length) {
    console.log('row NOT FOUND');
    db.close();
    return;
  }
  const r = rows[0]!;
  console.log('=== scalar columns ===');
  console.log(`40001 msgId   = ${r[0]}`);
  console.log(`40003 seq     = ${r[1]}`);
  console.log(`40008 local   = ${r[2]}`);
  console.log(`40011 type    = ${r[3]}`);
  console.log(`40012 subType = ${r[4]}`);
  console.log(`40013 ?       = ${r[5]}`);
  console.log(`40020 sender  = "${r[6]}"`);
  console.log(`40050 time    = ${r[7]}`);

  const blob = r[8];
  if (blob instanceof Uint8Array) {
    console.log(`\n=== 40800 raw BLOB (${blob.byteLength} bytes, hex) ===`);
    console.log(Buffer.from(blob).toString('hex'));
    console.log(`\n=== 40800 raw BLOB (base64) ===`);
    console.log(Buffer.from(blob).toString('base64'));
  }

  console.log('\n=== decoded elements ===');
  console.log(json(decodeBody(blob)));

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
