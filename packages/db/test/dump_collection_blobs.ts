/**
 * Dump the raw schema of `collection_list_info_table` and decode each row's
 * protobuf blob column(s) with the schema-free raw decoder, so we can see the
 * on-disk field layout and enumerate collection item `type`s.
 *
 * Run:  pnpm tsx ./packages/db/test/dump_collection_blobs.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decode } from '@weq/codec/raw';
import type { RawField, Guess } from '@weq/codec/raw';

/** Render the single best guess of each field as an indented tree. */
function renderTree(fields: RawField[], indent: number): string {
  const pad = ' '.repeat(indent);
  return fields
    .map((f) => {
      const g = f.guesses[0];
      if (!g) return `${pad}#${f.tag} (?)`;
      return `${pad}#${f.tag} ${describeGuess(g, indent)}`;
    })
    .join('\n');
}

function describeGuess(g: Guess, indent: number): string {
  switch (g.kind) {
    case 'len-nested':
      return `nested${g.consumedAll ? '' : '?'} {\n${renderTree(g.value, indent + 2)}\n${' '.repeat(indent)}}`;
    case 'len-utf8': {
      const s = g.value.length > 70 ? `${g.value.slice(0, 70)}…` : g.value;
      return `str(${g.value.length}): ${JSON.stringify(s)}`;
    }
    case 'len-bytes':
      return `bytes(${g.value.byteLength})`;
    case 'varint-timestamp-ms':
    case 'varint-timestamp-sec':
      return `ts: ${g.value.toISOString()}`;
    case 'varint-bool':
      return `bool: ${g.value}`;
    case 'varint-uint64':
    case 'varint-int64-zigzag':
    case 'i64-fixed':
      return `int: ${g.value}`;
    case 'i64-double':
    case 'i32-float':
      return `float: ${g.value}`;
    case 'i32-fixed':
      return `u32: ${g.value}`;
    default:
      return (g as { kind: string }).kind;
  }
}

const UIN = '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\collection.db`;

const TABLE = 'collection_list_info_table';

function isBlob(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  // 1) columns
  const info = await db.query(`PRAGMA table_info("${TABLE}")`);
  console.log(`\n=== ${TABLE} columns (${info.length}) ===`);
  for (const r of info) {
    console.log(`  ${String(r[1]).padEnd(10)} ${String(r[2] || '').padEnd(8)} pk=${r[5]}`);
  }

  const cols = info.map((r) => String(r[1]));
  const colList = cols.map((c) => `"${c}"`).join(',');
  const rows = await db.query(`SELECT ${colList} FROM "${TABLE}"`);
  console.log(`\nrows: ${rows.length}`);

  // 2) per-row: which column is the blob, and its top-level tag summary
  console.log(`\n=== per-row column value shapes (first 3 rows) ===`);
  rows.slice(0, 3).forEach((row, ri) => {
    console.log(`\n--- row ${ri} ---`);
    cols.forEach((c, i) => {
      const v = row[i];
      if (isBlob(v)) console.log(`  ${c} = <BLOB ${v.byteLength}B>`);
      else if (typeof v === 'string')
        console.log(`  ${c} = ${v.length > 60 ? `${v.slice(0, 60)}…` : v}`);
      else console.log(`  ${c} = ${String(v)}`);
    });
  });

  // 3) find blob columns
  const blobColIdx = cols
    .map((_, i) => i)
    .filter((i) => rows.some((r) => isBlob(r[i]) && (r[i] as Uint8Array).byteLength > 4));
  console.log(`\nblob columns: ${blobColIdx.map((i) => cols[i]).join(', ')}`);

  // 4) type (col 180002) distribution
  const typeCol = cols.indexOf('180002');
  const catCol = cols.indexOf('180003');
  const dist = new Map<string, number>();
  for (const r of rows) {
    const k = `type=${r[typeCol]} cat=${r[catCol]}`;
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  console.log(`\n=== (type,category) distribution ===`);
  [...dist.entries()].sort().forEach(([k, n]) => {
    console.log(`  ${k.padEnd(20)} ${n}`);
  });

  // 5) raw-decode blob 180004 for ONE representative row of each distinct type
  const seen = new Set<unknown>();
  console.log(`\n=== raw decode of blob 180004 (one sample per type) ===`);
  for (const r of rows) {
    const t = r[typeCol];
    if (seen.has(t)) continue;
    seen.add(t);
    console.log(`\n######## type=${t} cat=${r[catCol]} cid=${r[cols.indexOf('180001')]} ########`);
    for (const bc of ['180004', '180015']) {
      const bi = cols.indexOf(bc);
      const v = r[bi];
      if (!isBlob(v)) {
        console.log(`  [${bc}] not a blob: ${String(v)}`);
        continue;
      }
      console.log(`  [${bc}] ${v.byteLength}B:`);
      console.log(renderTree(decode(v), 2));
    }
  }

  db.close();
}

main().catch((e) => {
  console.error('[dump-collection-blobs] failed:', e);
  process.exit(1);
});
