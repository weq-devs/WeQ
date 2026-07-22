/**
 * 只读探针：逐列 dump market_emoticon_table（单表情维度），找有没有存 TEA key。
 * 用法: pnpm --filter @weq/db test:dump-market-emoticon
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv, qqDbPath } from '../../testkit/src/index';

function preview(val: unknown): string {
  if (val instanceof Uint8Array) return `<bytes ${val.length}> ${Buffer.from(val).toString('hex')}`;
  if (typeof val === 'bigint') return `${val}n`;
  return JSON.stringify(val);
}

async function main(): Promise<void> {
  const { ntHelper } = loadNative();
  const dbPath = qqDbPath('emoji.db');
  const key = testEnv.key;
  const probe = await ntHelper.testDatabaseKey(dbPath, key);
  const algo = { pageHmacAlgorithm: probe.pageHmacAlgorithm!, kdfHmacAlgorithm: probe.kdfHmacAlgorithm! };
  const db = new QqDb(ntHelper, { dbPath, key, algo });

  try {
    const cols = await db.query(`PRAGMA table_info("market_emoticon_table")`);
    const colNames = cols.map((c) => String((c as unknown[])[1]));

    const rows = await db.query(`SELECT * FROM "market_emoticon_table" LIMIT 3`);
    rows.forEach((row, i) => {
      console.log(`\n===== row ${i} =====`);
      (row as unknown[]).forEach((v, j) => console.log(`  ${colNames[j]} = ${preview(v)}`));
    });
  } finally {
    db.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
