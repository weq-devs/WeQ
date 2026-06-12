/**
 * 全库字符串搜索:在 nt_db 目录下所有 .db 文件的所有表所有列里,
 * 查找包含指定字符串(大小写均算命中,子串即可)的行。
 *
 * 用法: pnpm tsx packages/codec/test/search-string.ts [needle]
 *   不带参数则搜索默认的 f2e3... 哈希。
 *
 * 所有库共用 protolab 里硬编码的同一把 SQLCipher 密钥。
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadNative } from '../../native/src/index';
import type { NtHelperBinding, SqlValue } from '../../native/src/index';

const DB_DIR = String.raw`C:\Users\17078\Documents\Tencent Files\1707889225\nt_qq\nt_db`;
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const NEEDLE = (process.argv[2] ?? 'f2e37358c91fffddd18c0124fb035c7b').toLowerCase();

interface Hit {
  db: string;
  table: string;
  column: string;
  rowid: string;
  /** 命中列的值(截断展示)。 */
  preview: string;
}

/** 列出目录下真正的数据库文件,排除 -wal/-shm/.material 等附属文件。 */
function listDbFiles(): string[] {
  return readdirSync(DB_DIR)
    .filter((f) => f.endsWith('.db'))
    .sort();
}

async function query(
  nt: NtHelperBinding,
  dbPath: string,
  sql: string,
  params?: SqlValue[],
): Promise<SqlValue[][]> {
  return nt.executeSqlWithKey(dbPath, sql, KEY, params ?? null);
}

function previewOf(v: SqlValue): string {
  let s: string;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
    s = Buffer.from(v).toString('utf-8');
  } else {
    s = String(v ?? '');
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 160 ? s.slice(0, 160) + '…' : s;
}

async function searchDb(nt: NtHelperBinding, file: string, hits: Hit[]): Promise<void> {
  const dbPath = join(DB_DIR, file);
  let tables: SqlValue[][];
  try {
    tables = await query(
      nt,
      dbPath,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
  } catch (e) {
    console.error(`  [skip] ${file}: 打不开 (${String(e).split('\n')[0]})`);
    return;
  }

  for (const [tableNameRaw] of tables) {
    const table = String(tableNameRaw);
    const safeTable = table.replace(/"/g, '""');

    let cols: SqlValue[][];
    try {
      cols = await query(nt, dbPath, `PRAGMA table_info("${safeTable}")`);
    } catch {
      continue;
    }

    // cid|name|type|notnull|dflt|pk  → 取列名。把每列 CAST 成 TEXT 后做大小写无关子串匹配。
    const colNames = cols.map((c) => String(c[1]));
    if (colNames.length === 0) continue;

    const orClauses = colNames
      .map((c) => `instr(lower(CAST("${c.replace(/"/g, '""')}" AS TEXT)), ?) > 0`)
      .join(' OR ');

    // 选出 rowid + 所有列,过滤命中任意列的行。FTS 等无 rowid 的虚表会抛错,跳过即可。
    const selectCols = colNames.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ');
    const params: SqlValue[] = colNames.map(() => NEEDLE);

    let rows: SqlValue[][];
    try {
      rows = await query(
        nt,
        dbPath,
        `SELECT rowid, ${selectCols} FROM "${safeTable}" WHERE ${orClauses}`,
        params,
      );
    } catch {
      // 无 rowid 的虚表退化:不取 rowid 重试一次
      try {
        rows = await query(
          nt,
          dbPath,
          `SELECT ${selectCols} FROM "${safeTable}" WHERE ${orClauses}`,
          params,
        );
        rows = rows.map((r) => [null, ...r]);
      } catch (e) {
        console.error(`    [skip] ${file}.${table}: 查询失败 (${String(e).split('\n')[0]})`);
        continue;
      }
    }

    for (const row of rows) {
      const rowid = row[0] == null ? '(no rowid)' : String(row[0]);
      const values = row.slice(1);
      // 找出具体是哪一列命中(可能多列)
      for (let i = 0; i < colNames.length; i++) {
        const v = values[i];
        const text =
          v instanceof Uint8Array || Buffer.isBuffer(v)
            ? Buffer.from(v).toString('utf-8')
            : String(v ?? '');
        if (text.toLowerCase().includes(NEEDLE)) {
          hits.push({
            db: file,
            table,
            column: colNames[i]!,
            rowid,
            preview: previewOf(v),
          });
        }
      }
    }
  }
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const files = listDbFiles();
  console.log(`[search] 目录 ${DB_DIR}`);
  console.log(`[search] 共 ${files.length} 个 .db,搜索子串(大小写无关): "${NEEDLE}"\n`);

  const hits: Hit[] = [];
  for (const file of files) {
    process.stdout.write(`  扫描 ${file} …\n`);
    await searchDb(nt, file, hits);
  }

  console.log(`\n[search] ===== 命中 ${hits.length} 处 =====`);
  if (hits.length === 0) {
    console.log('  (未找到)');
  } else {
    for (const h of hits) {
      console.log(`\n  ${h.db}  →  表 ${h.table}  列 ${h.column}  rowid=${h.rowid}`);
      console.log(`    ${h.preview}`);
    }
  }

  nt.closeAllDb();
}

main().catch((e) => {
  console.error('[search] 失败:', e);
  process.exit(1);
});
