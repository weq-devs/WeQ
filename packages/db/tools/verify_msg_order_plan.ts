/**
 * EXPLAIN QUERY PLAN for the conversation queries after adding the
 * (40003, 40050, 40001) tie-break. The worry: a multi-column ORDER BY could
 * make SQLite abandon the `(40027,40003)` index and sort the whole partition.
 * Expected: still SEARCH ... USING INDEX, optionally with
 * "USE TEMP B-TREE FOR LAST TERM(S) OF ORDER BY" (the cheap in-group sort).
 * A full "SCAN" means the fix regressed performance and must be reverted.
 *
 * Run: pnpm tsx ./packages/db/tools/verify_msg_order_plan.ts
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const GROUP_COLS = `"40001","40020","40027","40033","40050","40800","40062","40003","40011","40012"`;
const C2C_COLS = `"40001","40020","40021","40030","40033","40050","40800","40003","40011","40012"`;
const NEWEST = `ORDER BY "40003" DESC, "40050" DESC, "40001" DESC`;
const OLDEST = `ORDER BY "40003" ASC, "40050" ASC, "40001" ASC`;

const QUERIES: Array<[string, string, unknown[]]> = [
  [
    'group listLatest',
    `SELECT ${GROUP_COLS} FROM group_msg_table WHERE "40027" = ? ${NEWEST} LIMIT ?`,
    ['673646675', 50n],
  ],
  [
    'group listBefore',
    `SELECT ${GROUP_COLS} FROM group_msg_table WHERE "40027" = ? AND "40003" < ? ${NEWEST} LIMIT ?`,
    ['673646675', 1454n, 50n],
  ],
  [
    'group listAfter',
    `SELECT ${GROUP_COLS} FROM group_msg_table WHERE "40027" = ? AND "40003" > ? ${OLDEST} LIMIT ?`,
    ['673646675', 1400n, 50n],
  ],
  [
    'group listFrom',
    `SELECT ${GROUP_COLS} FROM group_msg_table WHERE "40027" = ? AND "40003" >= ? ${NEWEST} LIMIT ?`,
    ['673646675', 1400n, 500n],
  ],
  [
    'c2c listLatest',
    `SELECT ${C2C_COLS} FROM c2c_msg_table WHERE "40027" = ? ${NEWEST} LIMIT ?`,
    [1n, 50n],
  ],
  [
    'c2c listBefore',
    `SELECT ${C2C_COLS} FROM c2c_msg_table WHERE "40027" = ? AND "40003" < ? ${NEWEST} LIMIT ?`,
    [1n, 100n, 50n],
  ],
  [
    'c2c listAfter',
    `SELECT ${C2C_COLS} FROM c2c_msg_table WHERE "40027" = ? AND "40003" > ? ${OLDEST} LIMIT ?`,
    [1n, 100n, 50n],
  ],
];

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.msgDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  let bad = 0;
  try {
    for (const [label, sql, params] of QUERIES) {
      const plan = await db.query(`EXPLAIN QUERY PLAN ${sql}`, params as never);
      const detail = plan.map((r) => String(r[3])).join(' | ');
      // A leading full-table SCAN is the failure mode; a TEMP B-TREE for the
      // trailing ORDER BY terms is expected and cheap.
      const scans = /SCAN (group_msg_table|c2c_msg_table)/.test(detail);
      const usesIndex = /USING (COVERING )?INDEX/.test(detail);
      const ok = usesIndex && !scans;
      if (!ok) bad++;
      console.log(`${ok ? '✅' : '❌'} ${label}\n     ${detail}`);
    }
  } finally {
    db.close();
  }
  console.log(`\n${bad === 0 ? '✅ 全部仍走索引' : `❌ ${bad} 条退化成全表扫描`}`);
  if (bad > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
