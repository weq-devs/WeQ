/**
 * Integration test for `GroupMsgDb` end-to-end.
 *
 * Run:  pnpm --filter @weq/db test:group-msg
 */

import { loadNative } from '@weq/native';
import { GroupMsgDb } from '../src/msg/group';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMsgDb(native.ntHelper, { dbPath: DB_PATH, key: KEY });

  console.log(`[test:group-msg] opening ${DB_PATH}`);
  const recent = await db.listRecent(5);
  console.log(`[test:group-msg] listRecent → ${recent.length} messages`);

  // Re-query the most recent group by its code to exercise listMessagesWithTarget.
  const code = recent[0]?.targetGroupCode;
  if (code) {
    const scoped = await db.listMessagesWithTarget(code, 5);
    console.log(`[test:group-msg] listMessagesWithTarget(${code}) → ${scoped.length} messages`);
  }

  console.log(JSON.stringify(recent, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  db.close();
}

main().catch((e) => {
  console.error('[test:group-msg] failed:', e);
  process.exit(1);
});
