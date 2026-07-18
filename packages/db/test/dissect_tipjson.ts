/**
 * 完整解剖 tipJson 灰条 7737024164892267232 的 40800 分层结构，为"SQL 拼接可行性"
 * 定位每一处：哪些是固定字节(可硬编码 X'..')，哪些随 uin/nick/seq 变(需动态)，
 * 以及两层长度前缀(MsgBody 外壳、tipJson field)分别怎么编码。
 *
 * 递归按 protobuf wire 解析，对每个 field 打印 (fieldNum, wireType, 偏移, 长度, 值)。
 * 全只读。
 */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;
const MSG_ID = BigInt(process.argv[2] ?? '7737024164892267232');

function readVarint(buf: Uint8Array, pos: number): [bigint, number, number] {
  let shift = 0n, val = 0n, start = pos;
  while (pos < buf.length) {
    const b = buf[pos]!; val |= BigInt(b & 0x7f) << shift; pos++;
    if ((b & 0x80) === 0) break; shift += 7n;
  }
  return [val, pos, pos - start];
}

function scan(buf: Uint8Array, base: number, indent: string, depth: number): void {
  let pos = 0;
  while (pos < buf.length) {
    const abs = base + pos;
    const [key, p1] = readVarint(buf, pos);
    const field = Number(key >> 3n), wt = Number(key & 7n);
    const keyBytes = Buffer.from(buf.subarray(pos, p1)).toString('hex');
    pos = p1;
    if (wt === 0) {
      const [v, p2] = readVarint(buf, pos); pos = p2;
      console.log(`${indent}@${abs} #${field} VARINT key=${keyBytes} = ${v}`);
    } else if (wt === 2) {
      const [len, p2, lenSize] = readVarint(buf, pos);
      const L = Number(len);
      const lenBytes = Buffer.from(buf.subarray(p2, p2 + lenSize)).toString('hex');
      const slice = buf.subarray(p2, p2 + L);
      pos = p2 + L;
      const printable = L > 0 && [...slice].every((c) => c === 0x0a || c === 0x09 || (c >= 0x20 && c < 0x7f));
      if (printable && L < 500) {
        console.log(`${indent}@${abs} #${field} LEN key=${keyBytes} lenPfx=${lenBytes}(${L}B) TEXT="${Buffer.from(slice).toString('utf8').slice(0, 80)}${L > 80 ? '…' : ''}"`);
      } else {
        console.log(`${indent}@${abs} #${field} LEN key=${keyBytes} lenPfx=${lenBytes}(${L}B) <bin ${Buffer.from(slice.subarray(0, 12)).toString('hex')}…>`);
        // 尝试递归子消息(仅当看起来像 protobuf：depth 限制)
        if (depth < 3 && L > 2 && !printable) {
          try { scan(slice, base + (p2 - 0), `${indent}  `, depth + 1); } catch { /* not a submsg */ }
        }
      }
    } else if (wt === 1) { pos += 8; console.log(`${indent}@${abs} #${field} 64BIT`); }
    else if (wt === 5) { pos += 4; console.log(`${indent}@${abs} #${field} 32BIT`); }
    else { console.log(`${indent}@${abs} #${field} wt=${wt} STOP`); break; }
  }
}

async function main(): Promise<void> {
  const nt = loadNative();
  const db = new QqDb(nt.ntHelper, { dbPath: DB, key: KEY, algo: ALGO });
  const rows = await db.query(
    `SELECT "40800" FROM group_msg_table WHERE "40001" = ? LIMIT 1`, [MSG_ID],
  );
  const blob = rows[0]?.[0];
  if (!(blob instanceof Uint8Array)) { console.log('not found / not blob'); db.close(); return; }

  console.log(`40800 = ${blob.byteLength} bytes\n全 hex:`);
  console.log(Buffer.from(blob).toString('hex'));
  console.log('\n=== 分层解析 ===');
  scan(blob, 0, '', 0);
  db.close();
}

main().catch((e) => { console.error('failed:', e instanceof Error ? e.message : e); process.exit(1); });
