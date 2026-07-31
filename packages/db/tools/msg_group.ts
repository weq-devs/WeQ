/**
 * Integration test for `GroupMsgDb` end-to-end.
 *
 * Run:  pnpm --filter @weq/db test:group-msg
 */

import { loadNative } from '@weq/native';
import { GroupMsgDb } from '../src/msg/group';
import { testEnv } from '@weq/testkit';

const DB_PATH = testEnv.msgDbPath;
const KEY = testEnv.key;

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[test:group-msg] opening ${DB_PATH}`);
  const recent = await db.listRecent(5);
  console.log(`[test:group-msg] listRecent → ${recent.length} messages`);

  // Re-query the most recent group by its code to exercise listLatest.
  const code = recent[0]?.targetGroupCode;
  if (code) {
    const scoped = await db.listLatest(code, 5);
    console.log(`[test:group-msg] listLatest(${code}) → ${scoped.length} messages`);
  }

  console.log(JSON.stringify(recent, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  db.close();
}

main().catch((e) => {
  console.error('[test:group-msg] failed:', e);
  process.exit(1);
});
