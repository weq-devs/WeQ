/**
 * Integration test for `RecentContactDb` end-to-end.
 *
 * Hits a real nt_msg.db on disk with the dev credentials hard-coded in
 * `apps/protolab/src/renderer/src/App.tsx`. Verifies the full pipeline:
 *   native (SQLCipher) → SQL → protobuf decode (40051 preview) → RecentContact.
 *
 * Run:  pnpm --filter @weq/db test:recent-contact
 *
 * Requires `native/win32/x64/nt_helper.node` to be in place. Skip the
 * test or supply env vars (`WEQ_TEST_DB_PATH` / `WEQ_TEST_DB_KEY`) if
 * you don't have the dev account's credentials.
 */

import { loadNative } from '@weq/native';
import { RecentContactDb } from '../src/contact/recent_contact';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

async function main(): Promise<void> {
  const native = loadNative();
  const db = new RecentContactDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[test:recent-contact] opening ${DB_PATH}`);
  const contacts = await db.getRecentContact(200);
  console.log(`[test:recent-contact] got ${contacts.length} contacts`);

  // Print a compact summary first so the result is legible at a glance.
  for (const c of contacts.slice(0, 20)) {
    const text = c.preview?.displayText ?? '(no displayText)';
    console.log(
      `  [${String(c.chatType).padEnd(22)}] ${c.targetDisplayName || c.targetUid} ` +
        `<- ${c.senderNick || c.senderUid}: ${text}`,
    );
  }

  // Then the full structured dump of the first few for field-level inspection.
  const json = JSON.stringify(contacts.slice(0, 5), bigintReplacer, 2);
  console.log('--- first 5 full ---');
  console.log(json);

  db.close();
}

function bigintReplacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? v.toString() : v;
}

main().catch((e) => {
  console.error('[test:recent-contact] failed:', e);
  process.exit(1);
});
