/**
 * Decode the CALL elements of specific msgIds from group_msg_table / c2c_msg_table.
 *
 * Run: pnpm tsx packages/db/tools/dump_call_element.ts <msgId> [<msgId> ...]
 */

import { loadNative } from '@weq/native';
import { testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(): Promise<void> {
  const ids = process.argv.slice(2);
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: ALGO,
  });

  for (const id of ids) {
    for (const table of ['group_msg_table', 'c2c_msg_table']) {
      const rows = await db.query(
        `SELECT "40001","40012","40020","40033","40050","40800" FROM ${table} WHERE "40001" = ?`,
        [id],
      );
      for (const r of rows) {
        console.log(
          `\n═══ ${table} msgId=${id} 40012=${r[1]} sender=${r[3]}(${r[2]}) time=${r[4]} ═══`,
        );
        console.log('raw 40800 hex:', Buffer.from(r[5] as Uint8Array).toString('hex'));
        console.log(json(decodeBody(r[5])));
      }
    }
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
