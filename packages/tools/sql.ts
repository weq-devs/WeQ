/**
 * 通用 SQL 控制台 —— 对 `nt_db/` 下任意一个 QQ 数据库执行任意 SQL。
 *
 * 吸收了旧的一次性 dump/schema 工具（dump_columns / table_indexes / msg_indexes /
 * dump_msg_by_id / dump_collection_tables / misc_db / dump_profile_info …）的日常用途：
 * 看表、看列、看一行原始数据、跑聚合。输出人眼可读，BLOB 按 utf-8 预览。
 *
 * 用法:
 *   pnpm --filter @weq/tools sql -- nt_msg "SELECT COUNT(*) FROM group_msg_table"
 *   pnpm --filter @weq/tools sql -- emoji ".tables"
 *   pnpm --filter @weq/tools sql -- nt_msg ".cols group_msg_table"
 *   pnpm --filter @weq/tools sql -- nt_msg ".schema group_msg_table"
 *   pnpm --filter @weq/tools sql -- nt_msg ".row group_msg_table 12345"   # 按 rowid 看整行
 *   pnpm --filter @weq/tools sql -- /abs/path/to.db "SELECT ..."          # 绝对路径也行
 *
 * 数据库名是 `nt_db/` 下的文件名（`nt_msg` / `nt_msg.db` 均可）；路径与密钥来自
 * 根目录 `.env`（@weq/testkit）。
 *
 * 写语句（INSERT / UPDATE / DELETE / CREATE / DROP / …）必须加 `--yes` —— 这些会改真实
 * QQ 数据。跑之前先退出 QQ，否则可能锁库。
 */

import { join } from 'node:path';
import { loadNative } from '@weq/native';
import type { SqlValue } from '@weq/native';
import { QqDb } from '@weq/db';
import { requireMutationConsent, testEnv, qqDbDir } from '@weq/testkit';

// ── CLI 解析 ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2).filter((a) => a !== '--');
const positional = argv.filter((a) => a !== '--yes');

if (positional.length < 2) {
  console.error(
    '用法: pnpm --filter @weq/tools sql -- <db> "<sql|.tables|.cols T|.schema T|.row T id>" [--yes]',
  );
  process.exit(1);
}

const DB_ARG = positional[0]!;
const SQL = positional.slice(1).join(' ');

function resolveDbPath(arg: string): string {
  if (/[\\/]/.test(arg)) return arg;
  return join(qqDbDir(), arg.endsWith('.db') ? arg : `${arg}.db`);
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

function preview(v: SqlValue | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) {
    const text = Buffer.from(v).toString('utf-8');
    const printable = /^[\x20-\x7e\u4e00-\u9fff\n\r\t]*$/.test(text);
    return printable
      ? `BLOB(${v.byteLength}B) ${JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)}`
      : `BLOB(${v.byteLength}B) ${Buffer.from(v).toString('hex').slice(0, 48)}…`;
  }
  return String(v);
}

function printRows(rows: SqlValue[][], columns?: string[]): void {
  if (rows.length === 0) {
    console.log('(0 rows)');
    return;
  }
  const header = columns ?? rows[0]!.map((_v, i) => `c${i}`);
  console.log(`  ${header.join(' | ')}`);
  console.log(`  ${header.map(() => '---').join('|')}`);
  for (const row of rows.slice(0, 500)) {
    console.log(`  ${row.map((v) => preview(v)).join(' | ')}`);
  }
  if (rows.length > 500) console.log(`  … 共 ${rows.length} 行，只显示前 500 行`);
  console.log(`\n(${rows.length} rows)`);
}

// ── 点命令 ───────────────────────────────────────────────────────────────────

async function dotCommand(db: QqDb, sql: string): Promise<boolean> {
  const [cmd, ...rest] = sql.trim().split(/\s+/);
  const arg = rest.join(' ');
  if (cmd !== '.tables' && cmd !== '.cols' && cmd !== '.schema' && cmd !== '.row') return false;

  switch (cmd) {
    case '.tables': {
      const rows = await db.query(
        `SELECT name, type FROM sqlite_master
          WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      );
      const named = rows.map((r): [string, string] => [String(r[0] ?? ''), String(r[1] ?? '')]);
      const width = Math.max(...named.map(([n]) => n.length));
      console.log(`${named.length} tables/views:\n`);
      for (const [name, type] of named) console.log(`  ${name.padEnd(width)}  ${type}`);
      console.log(`\n(${named.length})`);
      return true;
    }
    case '.cols': {
      if (!arg) throw new Error('.cols 需要表名');
      const info = await db.query(`PRAGMA table_info("${arg.replace(/"/g, '""')}")`);
      if (info.length === 0) throw new Error(`表不存在: ${arg}`);
      console.log(`${arg} 的列 (cid | name | type | notnull | pk):\n`);
      for (const r of info) {
        console.log(
          `  ${String(r[0]).padStart(3)}  ${String(r[1]).padEnd(12)} ${String(r[2] || '?').padEnd(10)} ` +
            `${Number(r[3]) ? 'NOT NULL' : '        '} ${Number(r[5]) ? 'PK' : ''}`,
        );
      }
      console.log(`\n(${info.length} columns)`);
      return true;
    }
    case '.schema': {
      if (!arg) throw new Error('.schema 需要表名');
      const rows = await db.query(`SELECT sql FROM sqlite_master WHERE name = ?`, [arg]);
      console.log(rows[0]?.[0] ?? `(找不到 ${arg})`);
      return true;
    }
    case '.row': {
      const [table, rowid] = rest;
      if (!table || !rowid) throw new Error('.row 需要: .row <table> <rowid>');
      const safe = table.replace(/"/g, '""');
      const info = await db.query(`PRAGMA table_info("${safe}")`);
      if (info.length === 0) throw new Error(`表不存在: ${table}`);
      const cols = info.map((r) => String(r[1]));
      const quoted = cols.map((c) => `"${c}"`).join(', ');
      const rows = await db.query(`SELECT ${quoted} FROM "${safe}" WHERE rowid = ?`, [
        Number(rowid),
      ]);
      if (rows.length === 0) {
        console.log(`(rowid=${rowid} 在 ${table} 中不存在)`);
        return true;
      }
      console.log(`${table} rowid=${rowid}:\n`);
      const values = rows[0]!;
      cols.forEach((c, i) => {
        console.log(`  ${c.padEnd(10)} = ${preview(values[i])}`);
      });
      return true;
    }
    default:
      return false;
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const DB_PATH = resolveDbPath(DB_ARG);
  const db = new QqDb(loadNative().ntHelper, {
    dbPath: DB_PATH,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[sql] ${DB_PATH}`);

  if (await dotCommand(db, SQL)) {
    db.close();
    return;
  }

  const isWrite =
    /^\s*(insert|update|delete|create|drop|alter|replace|attach|vacuum)\b/i.test(SQL) ||
    /^\s*pragma\s+\w+\s*=/i.test(SQL);
  if (isWrite) {
    requireMutationConsent(`对 ${DB_PATH} 执行写语句:\n    ${SQL}`);
  }

  console.log(`[sql] ${SQL}\n`);
  if (isWrite) {
    const affected = await db.write(SQL);
    console.log(`OK — ${affected} row(s) affected`);
  } else {
    printRows(await db.query(SQL));
  }

  db.close();
}

main().catch((e) => {
  console.error('[sql] failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
