/**
 * 扫描安卓备份 nt_msg.db 里出现过的 elementType，并跟 PC 库对比，
 * 列出「只在安卓出现」的那些。
 *
 * Run: pnpm --filter @weq/db tools:android-element-types [安卓目录]
 *      不传目录则用 .env 的 WEQ_TEST_ANDROID_ROOT。
 */

import { loadNative } from '@weq/native';
import type { NtHelperBinding } from '@weq/native';
import { ElementType, ProtoMsg } from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { sanitizeBytes } from '@weq/codec/raw';
import { androidBackup, androidEnv, testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';

const BODY = new ProtoMsg(MsgBody);
const TABLES = ['c2c_msg_table', 'group_msg_table', 'dataline_msg_table'];
/** 大号的库能到 3GB，一次 SELECT 全表会把行全读进内存，所以分页。 */
const PAGE = 20_000;

async function open(nt: NtHelperBinding, dbPath: string, key: string): Promise<QqDb> {
  const probe = await nt.testDatabaseKey(dbPath, key);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error(`密钥不正确或加密参数不支持: ${dbPath}`);
  }
  return new QqDb(nt, {
    dbPath,
    key,
    algo: {
      pageHmacAlgorithm: probe.pageHmacAlgorithm,
      kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
    },
  });
}

/** elementType → 出现次数（跨表合并）。 */
async function scan(db: QqDb, label: string): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const table of TABLES) {
    let seen = 0;
    let bad = 0;
    for (let offset = 0; ; offset += PAGE) {
      let rows: Awaited<ReturnType<QqDb['query']>>;
      try {
        rows = await db.query(
          `SELECT "40800" FROM "${table}" ORDER BY rowid LIMIT ${PAGE} OFFSET ${offset}`,
        );
      } catch {
        if (offset === 0) console.log(`  [${label}] ${table}: 不存在，跳过`);
        break;
      }
      if (rows.length === 0) break;
      seen += rows.length;
      for (const row of rows) {
        const body = row[0];
        if (!(body instanceof Uint8Array) || body.byteLength === 0) continue;
        try {
          for (const el of BODY.decode(sanitizeBytes(body, MsgBody)).elements ?? []) {
            const t = el.elementType;
            if (typeof t !== 'number') continue;
            counts.set(t, (counts.get(t) ?? 0) + 1);
          }
        } catch {
          bad++;
        }
      }
      if (rows.length < PAGE) break;
      if (seen % 200_000 === 0) console.log(`  [${label}] ${table}: …${seen} 行`);
    }
    if (seen > 0) {
      console.log(`  [${label}] ${table}: ${seen} 行${bad ? `，${bad} 行解析失败` : ''}`);
    }
  }
  return counts;
}

const typeName = (t: number): string => ElementType[t] ?? '未命名';
const sortedKeys = (m: Map<number, number>): number[] => [...m.keys()].sort((a, b) => a - b);

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const dirArg = process.argv[2];
  const backup = dirArg ? androidBackup(dirArg) : androidEnv;

  console.log(`扫描安卓库 ${backup.msgDbPath}`);
  console.log(`  uid = ${backup.uid}`);
  const androidDb = await open(nt, backup.msgDbPath, backup.key);
  const android = await scan(androidDb, 'android');
  androidDb.close();

  console.log(`\n扫描 PC 库 ${testEnv.msgDbPath}`);
  const pcDb = await open(nt, testEnv.msgDbPath, testEnv.key);
  const pc = await scan(pcDb, 'pc');
  pcDb.close();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`安卓 elementType: ${sortedKeys(android).join(', ')}`);
  console.log(`PC   elementType: ${sortedKeys(pc).join(', ')}`);

  const only = sortedKeys(android).filter((t) => !pc.has(t));
  console.log(`\n${'-'.repeat(60)}`);
  if (only.length === 0) {
    console.log('安卓没有 PC 之外的 elementType。');
    return;
  }
  console.log('仅安卓出现：');
  for (const t of only) {
    console.log(`  ${String(t).padStart(4)}  ${typeName(t).padEnd(16)} x${android.get(t)}`);
  }
}

main().catch((e) => {
  console.error('[android-element-types] failed:', e);
  process.exit(1);
});
