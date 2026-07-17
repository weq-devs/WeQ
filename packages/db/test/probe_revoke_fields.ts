/**
 * 扒真实撤回灰条(5/4)的 40800 字节，回答："灰条里标识撤回者用的是 uid(string) 还是
 * uin(可能是 varint 或 string)？" —— 决定 SQL 拼接可行性。
 *
 * 手工按 protobuf wire 扫最外层 GrayTipElement，列出每个 field 的 (fieldNumber,
 * wireType, 值预览)。重点看是否出现 uin 数字字段、以及它是 wireType 0(varint，难拼)
 * 还是 2(len-prefixed string，可拼)。全只读。
 *
 * Run: pnpm tsx packages/db/test/probe_revoke_fields.ts [table] [n]
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB =
  process.env.WEQ_TEST_DB_PATH ??
  String.raw`D:\estkim\T\Tencent Files\1707889225\nt_qq\nt_db\nt_msg.db`;
const TABLE = process.argv[2] ?? 'group_msg_table';
const N = Number(process.argv[3] ?? 3);

/** 读一个 varint，返回 [值, 新位置]。 */
function readVarint(buf: Uint8Array, pos: number): [bigint, number] {
  let shift = 0n;
  let val = 0n;
  while (pos < buf.length) {
    const b = buf[pos]!;
    val |= BigInt(b & 0x7f) << shift;
    pos++;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [val, pos];
}

const WT = ['VARINT', '64BIT', 'LEN', 'SGRP', 'EGRP', '32BIT'];

/** 扫一层 protobuf，打印每个 field。detailBytes>0 时对 LEN 字段预览内容。 */
function scan(buf: Uint8Array, indent: string): void {
  let pos = 0;
  while (pos < buf.length) {
    const [key, p1] = readVarint(buf, pos);
    const field = Number(key >> 3n);
    const wt = Number(key & 7n);
    pos = p1;
    if (wt === 0) {
      const [v, p2] = readVarint(buf, pos);
      pos = p2;
      console.log(`${indent}#${field} VARINT = ${v}`);
    } else if (wt === 2) {
      const [len, p2] = readVarint(buf, pos);
      const L = Number(len);
      const slice = buf.subarray(p2, p2 + L);
      pos = p2 + L;
      // 预览：可打印 ascii 就显示文本，否则 hex 前 16 字节
      const printable = [...slice].every((c) => c === 0x0a || c === 0x09 || (c >= 0x20 && c < 0x7f));
      const preview = printable
        ? JSON.stringify(Buffer.from(slice).toString('utf8')).slice(0, 60)
        : `<${L}B ${Buffer.from(slice.subarray(0, 16)).toString('hex')}${L > 16 ? '…' : ''}>`;
      console.log(`${indent}#${field} LEN(${L}) = ${preview}`);
    } else if (wt === 1) { pos += 8; console.log(`${indent}#${field} 64BIT`); }
    else if (wt === 5) { pos += 4; console.log(`${indent}#${field} 32BIT`); }
    else { console.log(`${indent}#${field} wt=${wt}(${WT[wt] ?? '?'}) — stop`); break; }
  }
}

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  const rows = await db.query(
    `SELECT "40001","40800" FROM ${TABLE} WHERE "40011"=5 AND "40012"=4 AND "40800" IS NOT NULL
      ORDER BY rowid DESC LIMIT ?`,
    [BigInt(N)],
  );
  console.log(`${TABLE}: ${rows.length} 条撤回灰条\n`);

  for (const r of rows) {
    const blob = r[1];
    if (!(blob instanceof Uint8Array)) continue;
    console.log(`════ msg ${r[0]}  (40800 ${blob.byteLength}B) ════`);
    console.log(`   hex: ${Buffer.from(blob).toString('hex')}`);
    console.log('   顶层 fields:');
    scan(blob, '     ');
    console.log('');
  }

  console.log('=== 关注 ===');
  console.log('  · 撤回者是不是只用 uid(LEN, 24B ascii u_...)？');
  console.log('  · 有没有 uin 数字字段？是 VARINT(难拼) 还是 LEN string(可拼)？');

  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
