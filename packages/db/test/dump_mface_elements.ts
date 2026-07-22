/**
 * 只读探针：从真实消息库里捞出所有商城表情（mface）element，dump 关键字段。
 *
 * 目的：回答「聊天渲染 mface 到底需不需要爆破」——
 *   - 若 element 自带 encryptKey(80824) = TEA 密钥 → 直接解密，无需爆破。
 *   - 若 encryptKey 为空 → 只能靠 emojiPackId 去 CDN + 爆破时间戳。
 * 同时统计样本量，供性能决策。
 *
 * 只读，走读连接，QQ 开着也能跑。零硬编码，全走 @weq/testkit。
 *
 * 用法: pnpm --filter @weq/db test:dump-mface-elements
 */

import { loadNative } from '@weq/native';
import type { SqlRow } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { rowToC2cMessage } from '@weq/codec';
import { testEnv } from '@weq/testkit';

const KEY = testEnv.key;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;
const DB = testEnv.msgDbPath;

const TABLES: ReadonlyArray<{ table: string }> = [
  { table: 'c2c_msg_table' },
  { table: 'group_msg_table' },
  { table: 'dataline_msg_table' },
];

function toHex(u?: Uint8Array): string {
  return u ? Buffer.from(u).toString('hex') : '';
}

async function main(): Promise<void> {
  const { ntHelper } = loadNative();
  const db = new QqDb(ntHelper, { dbPath: DB, key: KEY, algo: ALGO });

  console.log('[mface-el] DB:', DB);

  // element blob 里含 mface 的 wire tag：45002(elementType)=11 → d0fc15 0b。
  // 直接用 instr 预筛，避免全表解 protobuf。
  const NEEDLE = `X'd0fc150b'`;

  let total = 0;
  const packIds = new Set<string>();
  let withKey = 0;
  let withoutKey = 0;
  const samples: Array<Record<string, string>> = [];

  try {
    for (const { table } of TABLES) {
      let rows: SqlRow[];
      try {
        // 只取 40800 blob 列，直接喂给 codec 解 element（rowToC2cMessage 走
        // 命名列 row['40800']，故构造 {'40800': blob} 对象）。
        rows = await db.query(
          `SELECT "40800" FROM "${table}" WHERE "40800" IS NOT NULL AND instr("40800", ${NEEDLE}) > 0`,
        );
      } catch (e) {
        console.log(`[mface-el] skip ${table}: ${(e as Error).message}`);
        continue;
      }
      console.log(`[mface-el] ${table}: ${rows.length} 行含 mface`);

      for (const row of rows) {
        const blob = Array.isArray(row) ? row[0] : (row as Record<string, unknown>)['40800'];
        let msg;
        try {
          msg = rowToC2cMessage({ '40800': blob } as never);
        } catch {
          continue;
        }
        for (const el of msg.elements) {
          if (el.kind !== 'mface') continue;
          total++;
          packIds.add(String(el.emojiPackId));
          const key = el.encryptKey ?? '';
          if (key) withKey++;
          else withoutKey++;
          if (samples.length < 20) {
            samples.push({
              pack: String(el.emojiPackId),
              encryptKey: key,
              marketEmoticonId: toHex(el.marketEmoticonId),
              desc: el.emojiDesc ?? '',
              sizeInfo: toHex(el.sizeInfo),
            });
          }
        }
      }
    }
  } finally {
    db.close();
  }

  console.log(`\n=== 汇总 ===`);
  console.log(`mface element 总数: ${total}`);
  console.log(`唯一 emojiPackId: ${packIds.size}`);
  console.log(`带 encryptKey(80824): ${withKey}`);
  console.log(`不带 encryptKey: ${withoutKey}`);

  console.log(`\n=== 样本（前 ${samples.length} 个）===`);
  for (const s of samples) {
    console.log(
      `pack=${s.pack} key="${s.encryptKey}" mktId=${s.marketEmoticonId} desc=${JSON.stringify(s.desc)} size=${s.sizeInfo}`,
    );
  }
}

main().catch((e) => {
  console.error('[mface-el] failed:', e);
  process.exit(1);
});
