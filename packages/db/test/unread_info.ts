/**
 * Integration test for UnreadInfo end-to-end.
 * Tests: chatType=2, uid=673646675
 */

import { loadNative } from '@weq/native';
import { UnreadInfoDb } from '../src/msg/unread_info';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

async function main(): Promise<void> {
  const native = loadNative();
  const db = new UnreadInfoDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[test:unread-info] opening ${DB_PATH}`);

  const result = await db.getUnreadInfo(2, '673646675');
  console.log(`[test:unread-info] result for chatType=2, uid=673646675:`);
  console.log(JSON.stringify(result, bigintReplacer, 2));

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:unread-info] failed:', e);
  process.exit(1);
});
