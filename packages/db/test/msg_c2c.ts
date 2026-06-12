/**
 * Integration test for `C2cMsgDb` end-to-end.
 *
 * Hits a real nt_msg.db on disk with the dev credentials hard-coded in
 * `apps/protolab/src/renderer/src/App.tsx`. Verifies the full pipeline:
 *   native (SQLCipher) → SQL → protobuf decode (40800) → C2cMsg.
 *
 * Run:  pnpm --filter @weq/db test:c2c-msg
 *
 * Requires `native/win32/x64/nt_helper.node` to be in place. Skip the
 * test or supply env vars (`WEQ_TEST_DB_PATH` / `WEQ_TEST_DB_KEY`) if
 * you don't have the dev account's credentials.
 */

import { loadNative } from '@weq/native';
import { C2cMsgDb } from '../src/msg/c2c';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

async function main(): Promise<void> {
  const native = loadNative();
  const db = new C2cMsgDb(native.ntHelper, { dbPath: DB_PATH, key: KEY });

  console.log(`[test:c2c-msg] opening ${DB_PATH}`);
  const msgs = await db.listRecent(50);
  console.log(`[test:c2c-msg] got ${msgs.length} messages`);

  const json = JSON.stringify(msgs, bigintReplacer, 2);
  console.log(json);

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:c2c-msg] failed:', e);
  process.exit(1);
});
