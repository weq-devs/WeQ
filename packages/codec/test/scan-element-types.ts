/**
 * 扫描脚本:遍历 c2c_msg_table 与 group_msg_table 全表的 40800 列,
 * 统计出现过的 elementType,并为「未知类型」(不在 ElementType 枚举里)
 * 收集 rowid 方便用 protolab 定位。type=9(红包)已知,跳过收集。
 *
 * 用法: pnpm tsx packages/codec/test/scan-element-types.ts
 *
 * 直接复用 protolab 里硬编码的开发账号库路径与密钥。每行 40800 是一个
 * repeated ElementWire,解码后读取每个元素的 elementType (tag 45002)。
 */

import { ProtoMsg } from '../src/core';
import { MsgBody } from '../src/proto/msg/common/body';
import { sanitizeBytes } from '../src/raw';
import { ElementType } from '../src/element/types';
import { loadNative } from '../../native/src/index';
import { QqDb } from '../../db/src/qq_db';

const DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  'D:\\estkim\\T\\Tencent Files\\1707889225\\nt_qq\\nt_db\\nt_msg.db';
const DB_KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';

/** 已知类型,扫描时不当作 unknown 上报 rowid。9 = 红包。 */
const KNOWN_UNKNOWNS = new Set<number>([9]);

const bodyCodec = new ProtoMsg(MsgBody);

/** elementType 数字 → 枚举名,便于阅读。 */
function typeName(t: number): string {
  return ElementType[t] ?? `UNKNOWN(${t})`;
}

function isUnknown(t: number): boolean {
  return ElementType[t] === undefined;
}

interface TableResult {
  table: string;
  total: number;
  decodeErrors: number;
  emptyBlobs: number;
  counts: Map<number, number>;
  /** 未知 elementType → 命中的 rowid 列表(不含 KNOWN_UNKNOWNS)。 */
  unknownRowids: Map<number, string[]>;
}

async function scanTable(db: QqDb, table: string): Promise<TableResult> {
  console.log(`\n[scan] === ${table} ===`);
  const rows = await db.query(`SELECT rowid, "40800" FROM ${table}`);
  console.log(`[scan] 共 ${rows.length} 行,开始解码 40800 列`);

  const counts = new Map<number, number>();
  const unknownRowids = new Map<number, string[]>();
  let decodeErrors = 0;
  let emptyBlobs = 0;

  for (const row of rows) {
    const rowid = String(row[0]);
    const blob = row[1];
    if (!(blob instanceof Uint8Array) || blob.length === 0) {
      emptyBlobs++;
      continue;
    }
    try {
      const decoded = bodyCodec.decode(sanitizeBytes(blob, MsgBody));
      for (const el of decoded.elements ?? []) {
        const t = el.elementType;
        if (typeof t !== 'number') continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
        if (isUnknown(t) && !KNOWN_UNKNOWNS.has(t)) {
          const list = unknownRowids.get(t) ?? [];
          list.push(rowid);
          unknownRowids.set(t, list);
        }
      }
    } catch {
      decodeErrors++;
    }
  }

  return { table, total: rows.length, decodeErrors, emptyBlobs, counts, unknownRowids };
}

function report(r: TableResult): void {
  console.log(`\n[scan] === ${r.table} 结果 ===`);
  console.log(`[scan] 解码失败 ${r.decodeErrors} 行,空 BLOB ${r.emptyBlobs} 行`);
  console.log(`[scan] 出现过的 elementType (按出现次数降序):\n`);

  const sorted = [...r.counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    const flag = isUnknown(type) ? '  <-- UNKNOWN' : '';
    console.log(`  ${String(type).padStart(4)}  ${typeName(type).padEnd(14)}  x${count}${flag}`);
  }
  console.log(
    `\n[scan] 去重后共 ${r.counts.size} 种 elementType: ${sorted.map(([t]) => t).join(', ')}`,
  );

  // 未知类型 rowid(排除 type=9 红包)
  const unknowns = [...r.unknownRowids.entries()].sort((a, b) => a[0] - b[0]);
  if (unknowns.length === 0) {
    console.log(`[scan] 无需要定位的未知类型(已排除 9)`);
    return;
  }
  console.log(`\n[scan] 需要定位的未知类型 rowid(已排除 9 红包):`);
  for (const [type, rowids] of unknowns) {
    console.log(`  type=${type}  命中 ${rowids.length} 处,rowid:`);
    for (const id of rowids) console.log(`    ${id}`);
  }
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const db = new QqDb(nt, { dbPath: DB_PATH, key: DB_KEY });

  console.log(`[scan] 打开 ${DB_PATH}`);

  for (const table of ['c2c_msg_table', 'group_msg_table']) {
    const result = await scanTable(db, table);
    report(result);
  }

  db.close();
}

main().catch((e) => {
  console.error('[scan] 失败:', e);
  process.exit(1);
});
