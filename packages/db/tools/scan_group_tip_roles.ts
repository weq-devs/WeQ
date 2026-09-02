/**
 * Look closer at groupTipType 1/3: who is user1 vs user2, and how the
 * 48510/48511 flags correlate — needed to word the 灰条 correctly.
 *
 * Run: pnpm tsx packages/db/tools/scan_group_tip_roles.ts
 */

import { loadNative } from '@weq/native';
import { testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: ALGO,
  });

  const rows = await db.query(`SELECT "40001","40027","40020","40800" FROM group_msg_table`, []);

  const type1: any[] = [];
  const type3: any[] = [];
  const type5: any[] = [];
  const flagCombo = new Map<string, number>();
  const u1counts = new Map<string, number>();
  const u2counts = new Map<string, number>();

  for (const r of rows) {
    const blob = r[3];
    if (!(blob instanceof Uint8Array)) continue;
    let els: any;
    try {
      els = decodeBody(blob);
    } catch {
      continue;
    }
    for (const el of els ?? []) {
      if (el?.kind !== 'grayTipGroup') continue;
      const rec = {
        msgId: String(r[0]),
        group: String(r[1]),
        sender: String(r[2]),
        u1: `${el.user1Nick ?? ''}/${el.user1GroupNick ?? ''}/${el.user1Uid ?? ''}`,
        u2: `${el.user2Nick ?? ''}/${el.user2GroupNick ?? ''}/${el.user2Uid ?? ''}`,
        f48502: el.groupTipFlag48502,
        f48510: el.groupTipFlag48510,
        f48511: el.groupTipFlag48511,
        name: el.groupTipGroupName,
      };
      if (el.groupTipType === 1) {
        if (type1.length < 12) type1.push(rec);
        const k = `48510=${el.groupTipFlag48510 ?? '-'} 48511=${el.groupTipFlag48511 ?? '-'}`;
        flagCombo.set(k, (flagCombo.get(k) ?? 0) + 1);
        if (el.user1Uid) u1counts.set(el.user1Uid, (u1counts.get(el.user1Uid) ?? 0) + 1);
        if (el.user2Uid) u2counts.set(el.user2Uid, (u2counts.get(el.user2Uid) ?? 0) + 1);
      }
      if (el.groupTipType === 3) type3.push(rec);
      if (el.groupTipType === 5 && type5.length < 8) type5.push(rec);
    }
  }

  console.log('=== type=1 samples ===');
  for (const r of type1) console.log(JSON.stringify(r));
  console.log('\n=== type=1 flag combos ===', JSON.stringify([...flagCombo.entries()]));
  console.log('\n=== type=1 top user1 uids ===');
  console.log([...u1counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5));
  console.log('=== type=1 top user2 uids ===');
  console.log([...u2counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5));

  console.log('\n=== type=3 (all) ===');
  for (const r of type3) console.log(JSON.stringify(r));

  console.log('\n=== type=5 samples ===');
  for (const r of type5) console.log(JSON.stringify(r));

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
