/**
 * Scan group_msg_table for GRAY_TIP subType=4 (群提示) elements and tally the
 * distinct `groupTipType` values, printing one representative decode per type.
 *
 * Run: pnpm tsx packages/db/test/scan_group_tip_types.ts
 */

import { loadNative } from '@weq/native';
import { testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';
import { decodeBody } from '../src/msg/util';

const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: ALGO,
  });

  const tally = new Map<number, { count: number; sample: unknown; msgId: string }>();
  let scanned = 0;
  let grayTips = 0;
  const subTypeTally = new Map<number, number>();

  for (const table of ['group_msg_table', 'c2c_msg_table']) {
    const rows = await db.query(
      `SELECT "40001","40800" FROM ${table} LIMIT 2000000`,
      [],
    );
    console.log(`${table}: ${rows.length} rows`);
    for (const r of rows) {
      const blob = r[1];
      if (!(blob instanceof Uint8Array)) continue;
      scanned++;
      let els: any;
      try {
        els = decodeBody(blob);
      } catch {
        continue;
      }
      for (const el of els ?? []) {
        if (el?.elementType === 8) {
          grayTips++;
          subTypeTally.set(el.subType ?? 0, (subTypeTally.get(el.subType ?? 0) ?? 0) + 1);
        }
        if (el?.kind !== 'grayTipGroup') continue;
        const t = el.groupTipType ?? -1;
        const prev = tally.get(t);
        if (prev) prev.count++;
        else tally.set(t, { count: 1, sample: el, msgId: String(r[0]) });
      }
    }
  }

  console.log(`scanned=${scanned} grayTipElements=${grayTips}`);
  console.log('grayTip subType tally:', JSON.stringify([...subTypeTally.entries()].sort((a,b)=>a[0]-b[0])));

  for (const [t, info] of [...tally.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`\n=== groupTipType=${t}  count=${info.count}  msgId=${info.msgId} ===`);
    console.log(json(info.sample));
  }

  db.close();
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
