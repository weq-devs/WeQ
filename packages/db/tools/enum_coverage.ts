/**
 * 枚举覆盖率扫描：把 codec 里声明的枚举值 跟 真实库里出现过的值 对账，
 * 列出「声明了但从没见过」的（想触发它们就知道该找哪些玩法），
 * 以及「见过但没声明」的（枚举漏了）。
 *
 * 一次扫多个库（PC + 任意个安卓备份），因为同一个类型可能只在某个端出现。
 *
 * Run: pnpm --filter @weq/db tools:enum-coverage [安卓目录…]
 */

import { loadNative } from '@weq/native';
import type { NtHelperBinding } from '@weq/native';
import {
  ElementType,
  GrayTipSubType,
  PicSubType,
  ProtoMsg,
  TipGroupElementType,
} from '@weq/codec';
import { MsgBody } from '@weq/codec/proto/msg/40800';
import { sanitizeBytes } from '@weq/codec/raw';
import { MsgType } from '@weq/codec/proto/msg/40900';
import { androidBackup, testEnv } from '@weq/testkit';
import { QqDb } from '../src/qq_db';

const BODY = new ProtoMsg(MsgBody);
const TABLES = ['c2c_msg_table', 'group_msg_table', 'dataline_msg_table'];
/** 3GB 的库一次 SELECT 全表会爆内存。 */
const PAGE = 20_000;

/** 每个被追踪的枚举：实际出现的值 → 次数。 */
interface Tally {
  elementType: Map<number, number>;
  msgType: Map<number, number>;
  picSubType: Map<number, number>;
  grayTipSubType: Map<number, number>;
  tipGroupType: Map<number, number>;
}

const newTally = (): Tally => ({
  elementType: new Map(),
  msgType: new Map(),
  picSubType: new Map(),
  grayTipSubType: new Map(),
  tipGroupType: new Map(),
});

function bump(m: Map<number, number>, k: unknown): void {
  if (typeof k !== 'number') return;
  m.set(k, (m.get(k) ?? 0) + 1);
}

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

async function scan(db: QqDb, label: string, into: Tally): Promise<void> {
  for (const table of TABLES) {
    let seen = 0;
    let bad = 0;
    for (let offset = 0; ; offset += PAGE) {
      let rows: Awaited<ReturnType<QqDb['query']>>;
      try {
        rows = await db.query(
          `SELECT "40011","40800" FROM "${table}" ORDER BY rowid LIMIT ${PAGE} OFFSET ${offset}`,
        );
      } catch (e) {
        // 部分备份的库扫到尾部会报 malformed —— 保留已扫到的结果。
        console.log(`  [${label}] ${table}: 在 ${seen} 行处中断（${(e as Error).message}）`);
        break;
      }
      if (rows.length === 0) break;
      seen += rows.length;

      for (const row of rows) {
        bump(into.msgType, Number(row[0]));
        const body = row[1];
        if (!(body instanceof Uint8Array) || body.byteLength === 0) continue;
        try {
          for (const el of BODY.decode(sanitizeBytes(body, MsgBody)).elements ?? []) {
            const type = el.elementType;
            bump(into.elementType, type);
            if (type === ElementType.PIC) bump(into.picSubType, el.subType);
            if (type === ElementType.GRAY_TIP) {
              bump(into.grayTipSubType, el.subType);
              bump(into.tipGroupType, el.groupTipType);
            }
          }
        } catch {
          bad++;
        }
      }
      if (rows.length < PAGE) break;
    }
    if (seen > 0) console.log(`  [${label}] ${table}: ${seen} 行${bad ? `，${bad} 解析失败` : ''}`);
  }
}

/** 一个枚举的声明值（数字键 → 名字），跳过反向映射。 */
function declared(e: object): Map<number, string> {
  const out = new Map<number, string>();
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === 'number') out.set(v, k);
  }
  return out;
}

function report(title: string, e: object, seen: Map<number, number>): void {
  const decl = declared(e);
  const missing = [...decl.entries()].filter(([v]) => !seen.has(v)).sort((a, b) => a[0] - b[0]);
  const extra = [...seen.keys()].filter((v) => !decl.has(v)).sort((a, b) => a - b);

  console.log(`\n${'─'.repeat(66)}`);
  console.log(`${title}   声明 ${decl.size} 个，实际见过 ${seen.size} 个`);
  console.log('─'.repeat(66));

  if (missing.length === 0) {
    console.log('  ✓ 声明的值全都见过');
  } else {
    console.log('  从没出现过（可以想办法触发）：');
    for (const [v, name] of missing) console.log(`    ${String(v).padStart(4)}  ${name}`);
  }
  if (extra.length > 0) {
    console.log('  见过但枚举里没声明：');
    for (const v of extra) console.log(`    ${String(v).padStart(4)}  × ${seen.get(v)}`);
  }
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const total = newTally();

  console.log(`扫描 PC 库 ${testEnv.msgDbPath}`);
  const pc = await open(nt, testEnv.msgDbPath, testEnv.key);
  await scan(pc, 'pc', total);
  pc.close();

  for (const dir of process.argv.slice(2)) {
    const backup = androidBackup(dir);
    console.log(`\n扫描安卓库 ${backup.msgDbPath}  (uid ${backup.uid})`);
    const db = await open(nt, backup.msgDbPath, backup.key);
    await scan(db, 'android', total);
    db.close();
  }

  console.log(`\n${'='.repeat(66)}`);
  console.log('  枚举覆盖率（PC + 安卓 合并）');
  console.log('='.repeat(66));

  report('ElementType (45002)', ElementType, total.elementType);
  report('MsgType (列 40011)', MsgType, total.msgType);
  report('PicSubType (PIC 的 45003)', PicSubType, total.picSubType);
  report('GrayTipSubType (GRAY_TIP 的 45003)', GrayTipSubType, total.grayTipSubType);
  report('TipGroupElementType (48501)', TipGroupElementType, total.tipGroupType);
}

main().catch((e) => {
  console.error('[enum-coverage] failed:', e);
  process.exit(1);
});
