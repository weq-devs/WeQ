/**
 * Integration test: dump ALL recent contacts (recent_contact_v3_table).
 *
 * Unlike `recent_contact.ts` (which prints a small sample), this lists every
 * conversation with its msgSeq (column 40003) — handy for eyeballing the unread
 * pipeline end-to-end.
 *
 * Run:  pnpm --filter @weq/db test:recent-contact-all
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

  console.log(`[test:recent-contact-all] opening ${DB_PATH}`);
  const contacts = await db.getRecentContact(2000);
  console.log(`[test:recent-contact-all] got ${contacts.length} contacts\n`);

  for (const c of contacts) {
    console.log(c);
    // const name = c.targetDisplayName || c.targetUid;
    // const text = c.preview?.displayText ?? '(no displayText)';
    // console.log(
    //   `  [${String(c.chatType).padEnd(22)}] seq=${String(c.msgSeq).padEnd(8)} ` +
    //     `${name} <- ${c.senderNick || c.senderUid}: ${text}`,
    // );
  }

  db.close();
}

main().catch((e) => {
  console.error('[test:recent-contact-all] failed:', e);
  process.exit(1);
});
