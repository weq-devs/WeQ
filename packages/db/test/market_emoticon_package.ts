/**
 * 探针：dump emoji.db 里 market_emoticon_package_table 的表结构与样值。
 *
 * 商城表情（marketface）重构第 1 步——先摸清「表情包」维度的元数据长什么样。
 * 只读，不写库；密钥/路径全部来自 @weq/testkit（根 .env），无硬编码。
 *
 * 用法: pnpm tsx packages/db/test/market_emoticon_package.ts
 */

import { loadNative } from '@weq/native';
import type { SqlRow } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { MarketEmoticonPackageDb } from '../src/emoji/market_emoticon_package';
import { testEnv, qqDbPath } from '@weq/testkit';

const TABLE = 'market_emoticon_package_table';
const SAMPLE_LIMIT = 5;

async function main(): Promise<void> {
  const { ntHelper } = loadNative();
  const dbPath = qqDbPath('emoji.db');
  const key = testEnv.key;

  console.log('[mface-pkg] Opening:', dbPath);
  const probe = await ntHelper.testDatabaseKey(dbPath, key);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error('emoji.db 密钥错误或算法探测失败');
  }
  const algo = {
    pageHmacAlgorithm: probe.pageHmacAlgorithm,
    kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
  };

  const db = new QqDb(ntHelper, { dbPath, key, algo });

  try {
    // ---- 1. 建表 SQL（原样，含 QQ 的纯数字列名）------------------------------
    const createSql = await db.query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [TABLE],
    );
    if (createSql.length === 0) {
      console.log(`[mface-pkg] 表 ${TABLE} 不存在。当前库里的表：`);
      const tables = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      );
      for (const t of tables) console.log('   -', t[0]);
      return;
    }
    console.log('\n--- CREATE SQL ---');
    console.log(createSql[0]![0]);

    // ---- 2. 列信息（cid / name / type / notnull / dflt / pk）-----------------
    const cols = await db.query(`PRAGMA table_info("${TABLE}")`);
    console.log('\n--- 列信息 (cid | name | type | notnull | dflt | pk) ---');
    const colNames: string[] = [];
    for (const c of cols) {
      colNames.push(String(c[1]));
      console.log(`   ${c[0]}\t${c[1]}\t${c[2]}\tnn=${c[3]}\tdflt=${c[4]}\tpk=${c[5]}`);
    }

    // ---- 3. 行数 + 样值 -----------------------------------------------------
    const countRows = await db.query(`SELECT COUNT(*) FROM "${TABLE}"`);
    console.log(`\n[mface-pkg] 总行数: ${countRows[0]![0]}`);

    const samples = await db.query(`SELECT * FROM "${TABLE}" LIMIT ${SAMPLE_LIMIT}`);
    console.log(`\n--- 样值（前 ${samples.length} 行，按列名展开）---`);
    samples.forEach((row: SqlRow, i: number) => {
      console.log(`\n[row ${i}]`);
      row.forEach((val, j) => {
        const name = colNames[j] ?? `col${j}`;
        console.log(`   ${name} = ${preview(val)}`);
      });
    });

    // ---- 4. 走 MarketEmoticonPackageDb 解析器（验证 db 包的解析结果）----------
    const parser = new MarketEmoticonPackageDb(ntHelper, { dbPath, key, algo });
    const packages = await parser.listAll();
    console.log(`\n--- MarketEmoticonPackageDb.listAll() → ${packages.length} 个表情包 ---`);
    for (const p of packages) {
      const t = p.addTime ? new Date(p.addTime * 1000).toISOString().slice(0, 10) : '?';
      console.log(`   [${p.packId}] ${p.name} — ${p.summary} (added ${t})`);
    }
  } finally {
    db.close();
  }
}

/** 把 SqlValue 打成人类可读的一行：Uint8Array 显示 hex + 长度，其余原样。 */
function preview(val: unknown): string {
  if (val instanceof Uint8Array) {
    const hex = Buffer.from(val).toString('hex');
    const shown = hex.length > 120 ? `${hex.slice(0, 120)}…` : hex;
    return `<bytes ${val.length}> ${shown}`;
  }
  if (typeof val === 'bigint') return `${val}n`;
  return JSON.stringify(val);
}

main().catch((e) => {
  console.error('[mface-pkg] failed:', e);
  process.exit(1);
});
