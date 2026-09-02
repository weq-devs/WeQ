/**
 * Probe — measure how slow the current LIKE-based FTS search really is, and
 * inspect the real schema/indexes of QQ's `buddy_msg_fts.db` / `group_msg_fts.db`.
 *
 * Run:  pnpm --filter @weq/db tools:msg-fts-probe -- 45674567876545678
 *   or: WEQ_TEST_KEYWORD=45674567876545678 pnpm --filter @weq/db tools:msg-fts-probe
 *
 * Env (from root `.env`, via @weq/testkit):
 *   WEQ_TEST_QQ_ROOT   QQ nt_qq data root
 *   WEQ_TEST_DB_KEY    SQLCipher key
 *   WEQ_LOG_DIR        (optional) native log dir; set to a writable path if the
 *                      default AppData location is not writable.
 */

import { performance } from 'node:perf_hooks';
import { loadNative } from '@weq/native';
import { BuddyMsgFtsDb, GroupMsgFtsDb } from '../src/index';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const NT_DB_DIR = testEnv.qqRoot + '\\nt_db';
const KEYWORD =
  process.argv.slice(2).find((a) => a !== '--') ??
  process.env.WEQ_TEST_KEYWORD ??
  '45674567876545678';
const ALGO = { pageHmacAlgorithm: 'SHA1' as const, kdfHmacAlgorithm: 'SHA512' as const };

async function main(): Promise<void> {
  const native = loadNative();
  const nt = native.ntHelper;

  const buddy = new BuddyMsgFtsDb(nt, {
    dbPath: `${NT_DB_DIR}\\buddy_msg_fts.db`,
    key: KEY,
    algo: ALGO,
  });
  const group = new GroupMsgFtsDb(nt, {
    dbPath: `${NT_DB_DIR}\\group_msg_fts.db`,
    key: KEY,
    algo: ALGO,
  });

  console.log(`[probe] keyword="${KEYWORD}"`);
  console.log(`[probe] nt_db=${NT_DB_DIR}`);

  for (const [label, db] of [
    ['buddy_msg_fts', buddy],
    ['group_msg_fts', group],
  ] as const) {
    console.log(`\n===== ${label}.db =====`);
    await inspectDb(nt, `${NT_DB_DIR}\\${label}.db`);
    await benchmark(db as BuddyMsgFtsDb, label);
  }

  buddy.close();
  group.close();
}

async function inspectDb(
  nt: ReturnType<typeof loadNative>['ntHelper'],
  dbPath: string,
): Promise<void> {
  try {
    const t0 = performance.now();
    const rows = await nt.executeSqlWithKey(
      dbPath,
      `SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`,
      KEY,
      ALGO,
      null,
    );
    const openMs = performance.now() - t0;
    console.log(`  [schema] open+read took ${openMs.toFixed(0)}ms`);

    for (const r of rows) {
      const type = String(r[0] ?? '');
      const name = String(r[1] ?? '');
      const tbl = String(r[2] ?? '');
      const sql = String(r[3] ?? '');
      if (type === 'table') {
        const cols = await nt.executeSqlWithKey(
          dbPath,
          `PRAGMA table_info("${name}")`,
          KEY,
          ALGO,
          null,
        );
        const colNames = cols.map((c) => String(c[1])).join(', ');
        console.log(`  [table] ${name} cols=[${colNames}]`);
        console.log(`    sql: ${sql.replace(/\s+/g, ' ').slice(0, 500)}`);
      } else if (type === 'index') {
        console.log(
          `  [index] ${name} on ${tbl}: ${sql ? sql.replace(/\s+/g, ' ').slice(0, 300) : '(implicit)'}`,
        );
      } else {
        console.log(`  [${type}] ${name}: ${sql ? sql.replace(/\s+/g, ' ').slice(0, 300) : ''}`);
      }
    }
  } catch (e) {
    console.log(`  [schema] FAILED: ${(e as Error).message.split('\n')[0]}`);
  }
}

async function benchmark(db: BuddyMsgFtsDb, label: string): Promise<void> {
  const table = label;
  // biome-ignore lint/complexity/useLiteralKeys: 探测脚本需直连底层连接,qq 是 private,写成 db.qq 会报 TS2341。
  const qq = db['qq'];

  // Row count (isolated — the FTS5 tokenizer must not be involved here).
  try {
    const t0 = performance.now();
    const countRows = await qq.query(`SELECT COUNT(*) FROM ${table}`);
    console.log(
      `  [count] ${Number(countRows[0]?.[0] ?? 0)} rows in ${(performance.now() - t0).toFixed(0)}ms`,
    );
  } catch (e) {
    console.log(`  [count] FAILED: ${(e as Error).message.split('\n')[0]}`);
  }

  // Does the keyword exist at all? Full scan COUNT (worst case for LIKE).
  try {
    const t1 = performance.now();
    const scanRows = await qq.query(
      `SELECT COUNT(*) FROM ${table} WHERE ("41701" LIKE ? ESCAPE '\\' OR "41702" LIKE ? ESCAPE '\\')`,
      [`%${KEYWORD}%`, `%${KEYWORD}%`],
    );
    console.log(
      `  [full-scan] LIKE matches=${Number(scanRows[0]?.[0] ?? 0)} took ${(performance.now() - t1).toFixed(0)}ms`,
    );
  } catch (e) {
    console.log(`  [full-scan] FAILED: ${(e as Error).message.split('\n')[0]}`);
  }

  // Current implementation: pool + rank. Cold first then warm.
  try {
    for (let i = 0; i < 3; i += 1) {
      const tag = i === 0 ? 'cold ' : `warm#${i}`;
      const t2 = performance.now();
      const hits = await db.search(KEYWORD, 5);
      const ms = performance.now() - t2;
      console.log(`  [like-search ${tag}] ${hits.length} hit(s) in ${ms.toFixed(1)}ms`);
      if (i === 0) {
        for (const h of hits.slice(0, 3)) {
          const preview = h.content.length > 40 ? `${h.content.slice(0, 40)}…` : h.content;
          console.log(
            `      msgId=${h.msgId} target=${h.targetUid} sender=${h.senderUid} time=${h.sendTime}`,
          );
          console.log(`      ${preview}`);
        }
      }
    }
  } catch (e) {
    console.log(`  [like-search] FAILED: ${(e as Error).message.split('\n')[0]}`);
  }

  // Probe the FTS5 virtual table (QQ's own pinyin_letter tokenizer).
  try {
    const t3 = performance.now();
    const fts = await qq.query(`SELECT COUNT(*) FROM ${table}_fts WHERE ${table}_fts MATCH ?`, [
      KEYWORD,
    ]);
    console.log(
      `  [fts5 MATCH] ${fts[0]?.[0]} hit(s) in ${(performance.now() - t3).toFixed(0)}ms (UNEXPECTED: it worked!)`,
    );
  } catch (e) {
    console.log(`  [fts5 MATCH] failed as expected: ${(e as Error).message.split('\n')[0]}`);
  }

  // 40027 stats + indexes.
  try {
    const d27 = await qq.query(
      `SELECT COUNT(DISTINCT "40027") AS d, COUNT("40027") AS n, MIN("40027") AS lo, MAX("40027") AS hi FROM ${table}`,
    );
    console.log(
      `  [col 40027] distinct=${d27[0]?.[0]} nonNull=${d27[0]?.[1]} range=[${d27[0]?.[2]}..${d27[0]?.[3]}]`,
    );
    const idx = await qq.query(`PRAGMA index_list("${table}")`);
    for (const r of idx) {
      console.log(
        `  [pragma index] seq=${r[0]} name=${r[1]} unique=${r[2]} origin=${r[3]} partial=${r[4]}`,
      );
    }
  } catch (e) {
    console.log(`  [col 40027] FAILED: ${(e as Error).message.split('\n')[0]}`);
  }
}

main().catch((e) => {
  console.error('[probe] failed:', e);
  process.exit(1);
});
