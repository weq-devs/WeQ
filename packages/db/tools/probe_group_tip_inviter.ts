/**
 * For groupTipType=1 (成员加入), check whether `user2` is the group owner /
 * admin (i.e. the inviter) — decides the 灰条 wording「A 邀请 B 加入了群聊」.
 *
 * Run: pnpm tsx packages/db/tools/probe_group_tip_inviter.ts
 */

import { loadNative } from '@weq/native';
import { testEnv, qqDbPath } from '@weq/testkit';
import { GroupMemberDb } from '../src/group_info/member';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

/** (groupCode, user1Uid, user2Uid) triples pulled from scan_group_tip_roles. */
const CASES: Array<[string, string, string]> = [
  ['1090875633', 'u_wot4gwdicYVLeCPJeZWWKg', 'u_yOu9PO-dy-QCf1KemraEAQ'],
  ['948815682', 'u_SPm3TUPuQkQq6Ub_aXEu9Q', 'u_VgoOtXAlPDY_4Y3fankhGw'],
  ['602142028', 'u_nL1rkwGgll4EN-qhROVlng', 'u_QxYJh53Hh1vjs9XFhaeR9Q'],
  ['1081108335', 'u_XmcxSm0fF-L0KsvOrFgmFQ', 'u_mGIBTBW7gF4Wocw8zapc6w'],
];

async function main(): Promise<void> {
  const native = loadNative();
  const db = new GroupMemberDb(native.ntHelper, {
    dbPath: qqDbPath('group_info.db'),
    key: testEnv.key,
    algo: ALGO,
  });

  for (const [group, u1, u2] of CASES) {
    const members = await db.listMembersInGroup(BigInt(group), 5000);
    const find = (uid: string) => members.find((m: any) => m.uid === uid);
    const m1: any = find(u1);
    const m2: any = find(u2);
    console.log(`\ngroup=${group} members=${members.length}`);
    console.log(
      `  user1 ${u1}: ${m1 ? `nick=${m1.nick} role=${m1.role ?? m1.memberRole ?? '?'} joinTime=${m1.joinTime}` : 'NOT A MEMBER'}`,
    );
    console.log(
      `  user2 ${u2}: ${m2 ? `nick=${m2.nick} role=${m2.role ?? m2.memberRole ?? '?'} joinTime=${m2.joinTime}` : 'NOT A MEMBER'}`,
    );
    if (m1) console.log(`  user1 raw: ${JSON.stringify(m1, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (m2) console.log(`  user2 raw: ${JSON.stringify(m2, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
