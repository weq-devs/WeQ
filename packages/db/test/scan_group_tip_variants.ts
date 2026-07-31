/**
 * Group the real GRAY_TIP subType=4 rows by (groupTipType, present-field set)
 * so each rendering variant gets one representative sample.
 *
 * Run: pnpm tsx packages/db/test/scan_group_tip_variants.ts
 */

import { loadNative } from '@weq/native';
import { testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

const FIELDS = [
  'user1Uid',
  'user1Nick',
  'user1GroupNick',
  'user2Uid',
  'user2Nick',
  'user2GroupNick',
  'muteInfo',
  'groupTipGroupName',
  'groupTipFlag48502',
  'groupTipFlag48510',
  'groupTipFlag48511',
];

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: ALGO,
  });

  const variants = new Map<string, { count: number; sample: any; msgId: string }>();

  for (const table of ['group_msg_table', 'c2c_msg_table']) {
    const rows = await db.query(`SELECT "40001","40800" FROM ${table}`, []);
    for (const r of rows) {
      const blob = r[1];
      if (!(blob instanceof Uint8Array)) continue;
      let els: any;
      try {
        els = decodeBody(blob);
      } catch {
        continue;
      }
      for (const el of els ?? []) {
        if (el?.kind !== 'grayTipGroup') continue;
        const present = FIELDS.filter((f) => {
          const v = el[f];
          return v !== undefined && v !== '' && v !== null;
        });
        const key = `${el.groupTipType ?? -1}|${present.join(',')}`;
        const prev = variants.get(key);
        if (prev) prev.count++;
        else variants.set(key, { count: 1, sample: el, msgId: String(r[0]) });
      }
    }
  }

  const sorted = [...variants.entries()].sort((a, b) => {
    const ta = Number(a[0].split('|')[0]);
    const tb = Number(b[0].split('|')[0]);
    return ta - tb || b[1].count - a[1].count;
  });

  for (const [key, info] of sorted) {
    const [t, fields] = key.split('|');
    console.log(`\n--- type=${t} count=${info.count} msgId=${info.msgId}`);
    console.log(`    fields: ${fields}`);
    const picked: Record<string, unknown> = {};
    for (const f of FIELDS) if (info.sample[f] !== undefined) picked[f] = info.sample[f];
    console.log(`    ${json(picked)}`);
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
