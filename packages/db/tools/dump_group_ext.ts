/**
 * Probe script — dump `group_ext_list` from group_info.db.
 *
 * Prints every column for up to N groups, showing raw value + storage class.
 * For BLOB columns it also attempts a best-effort protobuf wire-format decode
 * using the codec dictionary so we can identify field tags / types.
 *
 * Run:
 *   pnpm tsx ./packages/db/tools/dump_group_ext.ts [--limit <n>] [--group <groupCode>]
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv, qqDbPath } from '@weq/testkit';
import { raw } from '@weq/codec';

const DB_PATH = qqDbPath('group_info.db');
const KEY = testEnv.key;

function storageClass(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Uint8Array) return 'BLOB';
  if (typeof v === 'bigint') return 'INTEGER';
  if (typeof v === 'number') return Number.isInteger(v) ? 'INTEGER' : 'REAL';
  if (typeof v === 'string') return 'TEXT';
  return typeof v;
}

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<BLOB ${v.byteLength} bytes>`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'string')
    return v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : JSON.stringify(v);
  return String(v);
}

/** Best-effort raw protobuf decode — shows tag→best-guess pairs. */
function tryDecodeProto(buf: Uint8Array): string {
  try {
    const fields = raw.decode(buf);
    if (fields.length === 0) return '(empty proto)';
    return fields
      .map((f) => {
        const best = f.guesses[0];
        if (!best) return `  tag=${f.tag} wt=${f.wireType} → (no guess)`;
        let valStr: string;
        if (best.kind === 'len-nested') {
          valStr = `NESTED(${(best.value as unknown[]).length} fields)`;
        } else if (best.kind === 'len-bytes') {
          const v = best.value as Uint8Array;
          valStr = `BYTES(${v.byteLength}): ${Buffer.from(v).toString('hex').slice(0, 64)}`;
        } else {
          valStr = String(best.value);
        }
        return `  tag=${f.tag} [${best.kind}] = ${valStr}`;
      })
      .join('\n');
  } catch (e) {
    return `(decode failed: ${e})`;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let limit = 5;
  let targetGroup: bigint | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) limit = Number(args[++i]);
    if (args[i] === '--group' && args[i + 1]) targetGroup = BigInt(args[++i]!);
  }

  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  console.log(`[dump-group-ext] opening ${DB_PATH}\n`);

  // ── 1. schema ──────────────────────────────────────────────────────────────
  const infoRows = await db.query(`PRAGMA table_info("group_ext_list")`);
  const cols = infoRows.map((r) => String(r[1]));
  console.log(`=== group_ext_list columns (${cols.length}) ===`);
  infoRows.forEach((r) => {
    console.log(`  cid=${r[0]}  name="${r[1]}"  type=${r[2]}`);
  });

  // ── 2. row count ──────────────────────────────────────────────────────────
  const countRow = await db.query(`SELECT COUNT(*) FROM "group_ext_list"`);
  console.log(`\nTotal rows: ${countRow[0]?.[0]}`);

  // ── 3. sample rows ────────────────────────────────────────────────────────
  const quotedCols = cols.map((c) => `"${c}"`).join(',');
  const where = targetGroup ? `WHERE "60001" = ${targetGroup}` : '';
  const rows = await db.query(`SELECT ${quotedCols} FROM "group_ext_list" ${where} LIMIT ${limit}`);

  for (const [ri, row] of rows.entries()) {
    const groupCode = row[cols.indexOf('60001')] ?? row[0];
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`ROW ${ri + 1}  groupCode=${groupCode}`);
    console.log('═'.repeat(60));

    for (const [ci, colName] of cols.entries()) {
      const val = row[ci];
      const sc = storageClass(val);
      console.log(`  ${colName.padEnd(8)} [${sc.padEnd(7)}] = ${describe(val)}`);

      if (val instanceof Uint8Array && val.byteLength > 0) {
        console.log('    hex:', Buffer.from(val).toString('hex').slice(0, 128));
        console.log('    proto-scan:');
        const decoded = tryDecodeProto(val);
        for (const l of decoded.split('\n')) {
          console.log(`    ${l}`);
        }
      }
    }
  }

  db.close();
}

main().catch((e) => {
  console.error('[dump-group-ext] failed:', e);
  process.exit(1);
});
