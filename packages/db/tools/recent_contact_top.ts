/**
 * Verify `RecentContactTopDb` against the live nt_msg.db — prints every pinned
 * conversation and joins it against `recent_contact_v3_table` so the resolved
 * `targetId` can be eyeballed against a real conversation name.
 *
 * Run:  pnpm tsx ./packages/db/tools/recent_contact_top.ts
 */

import { loadNative } from '@weq/native';
import { RecentContactTopDb } from '../src/contact/recent_contact_top';
import { RecentContactDb } from '../src/contact/recent_contact';
import { testEnv } from '@weq/testkit';

async function main(): Promise<void> {
  const native = loadNative();
  const opts = {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const,
  };
  const topDb = new RecentContactTopDb(native.ntHelper, opts);
  const contactDb = new RecentContactDb(native.ntHelper, opts);

  const tops = await topDb.getTopContacts();
  const nameById = new Map(
    (await contactDb.getRecentContact(500)).map((c) => [c.targetUid, c.targetDisplayName]),
  );

  console.log(`置顶会话 ${tops.length} 个：\n`);
  for (const top of tops) {
    const when = new Date(Number(top.topTime) * 1000).toLocaleString('zh-CN');
    const name = nameById.get(top.targetId) ?? '(不在最近会话列表里)';
    console.log(
      `  ${top.chatType.toString().padEnd(16)} ${top.targetId.padEnd(26)} ${when}  ${name}`,
    );
  }

  topDb.close();
  contactDb.close();
}

main().catch((e) => {
  console.error('[recent-contact-top] failed:', e);
  process.exit(1);
});
