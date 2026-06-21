/**
 * Replicate the frontend unread computation end-to-end:
 *   unread = recentContact.msgSeq(40003)  -  unreadInfo.msgSeq(41002)
 * for every recent contact, matching MainView.loadUnread exactly.
 *
 * Run: pnpm tsx .\packages\db\test\unread_calc.ts
 */

import { loadNative } from '@weq/native';
import { RecentContactDb } from '../src/contact/recent_contact';
import { UnreadInfoDb } from '../src/msg/unread_info';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

function chatTypeKind(chatType: string): 'direct' | 'group' | null {
  const s = String(chatType);
  if (s.includes('C2C')) return 'direct';
  if (s.includes('GROUP')) return 'group';
  return null;
}

async function main(): Promise<void> {
  const native = loadNative();
  const recent = new RecentContactDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });
  const unread = new UnreadInfoDb(native.ntHelper, { dbPath: DB_PATH, key: KEY, algo: ALGO });

  const contacts = await recent.getRecentContact(200);
  console.log(`[unread-calc] ${contacts.length} contacts\n`);

  for (const c of contacts.slice(0, 30)) {
    const kind = chatTypeKind(String(c.chatType));
    if (kind === null) continue;
    const chatType = kind === 'group' ? 2 : 1;
    const info = await unread.getUnreadInfo(chatType, c.targetUid);
    const latest = c.msgSeq;
    const read = info?.msgSeq !== undefined ? BigInt(info.msgSeq) : 0n;
    const count = latest > read ? Number(latest - read) : 0;
    const name = c.targetDisplayName || c.targetUid;
    console.log(
      `${count > 99 ? '99+' : String(count).padStart(3)} | latest=${String(latest).padStart(8)} read=${String(info?.msgSeq ?? 'NULL').padStart(8)} | [${chatType}_${c.targetUid}] ${name}`,
    );
  }

  recent.close();
  unread.close();
}

main().catch((e) => {
  console.error('[unread-calc] failed:', e);
  process.exit(1);
});
