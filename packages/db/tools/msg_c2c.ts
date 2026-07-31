/**
 * Integration test for `C2cMsgDb` end-to-end.
 *
 * Hits a real nt_msg.db on disk using the credentials from the root `.env`
 * (see `@weq/testkit` / `.env.example`). Verifies the full pipeline:
 *   native (SQLCipher) → SQL → protobuf decode (40800) → C2cMsg.
 *
 * Run:  pnpm --filter @weq/db test:c2c-msg
 *
 * Requires `native/win32/x64/nt_helper.node` to be in place, plus a configured
 * `.env` (WEQ_TEST_QQ_ROOT / WEQ_TEST_DB_KEY).
 */

import { loadNative } from '@weq/native';
import { C2cMsgDb } from '../src/msg/c2c';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;

async function main(): Promise<void> {
  const native = loadNative();
  const db = new C2cMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

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
