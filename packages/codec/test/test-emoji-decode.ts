/**
 * 验证脚本:解析 group_msg_table 的 40062 列(贴表情 / sticker reactions)。
 *
 * 用法: pnpm tsx packages/codec/test/test-emoji-decode.ts
 *
 * 目标行: 7725570840783887852(先按 40001 msgId 查,查不到再按 rowid 查)。
 * 该行带有贴表情内容,期望解出 setEmojiList。
 */

import { loadNative } from '../../native/src/index';
import { QqDb } from '../../db/src/qq_db';
import { decodeEmoji } from '../../db/src/msg/util';

const DB_PATH = 'D:\\estkim\\T\\Tencent Files\\1707889225\\nt_qq\\nt_db\\nt_msg.db';
const DB_KEY = '^;<kXZ;RI[@]yTD<';
const TABLE = 'group_msg_table';
const TARGET = '7725570840783887852';

function toHex(buf: unknown): string {
  if (!(buf instanceof Uint8Array)) return '(not bytes)';
  return Buffer.from(buf).toString('hex');
}

async function main() {
  const { ntHelper } = loadNative();

  // Probe the SQLCipher algorithms (mirrors apps/protolab getDb()).
  const probe = await ntHelper.testDatabaseKey(DB_PATH, DB_KEY);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error('数据库密钥错误或算法探测失败');
  }
  const algo = {
    pageHmacAlgorithm: probe.pageHmacAlgorithm,
    kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
  };

  const db = new QqDb(ntHelper, { dbPath: DB_PATH, key: DB_KEY, algo });

  // 先按 40001(msgId)查,查不到再按 rowid 查。
  let rows = await db.query(
    `SELECT rowid, "40001", "40062" FROM ${TABLE} WHERE "40001" = ? LIMIT 1`,
    [BigInt(TARGET)],
  );
  let matchedBy = '40001';
  if (rows.length === 0) {
    rows = await db.query(
      `SELECT rowid, "40001", "40062" FROM ${TABLE} WHERE rowid = ? LIMIT 1`,
      [BigInt(TARGET)],
    );
    matchedBy = 'rowid';
  }

  if (rows.length === 0) {
    console.error(`❌ 未找到目标行 ${TARGET}(既不是 40001 也不是 rowid)`);
    db.close();
    return;
  }

  const row = rows[0]!;
  console.log(`✅ 命中 (by ${matchedBy}): rowid=${row[0]} 40001=${row[1]}`);

  const blob = row[2];
  console.log(`40062 raw hex: ${toHex(blob)}`);
  console.log(`40062 byteLength: ${blob instanceof Uint8Array ? blob.length : 0}`);

  const setEmojiList = decodeEmoji(blob);
  console.log('\n解析结果 setEmojiList:');
  console.log(JSON.stringify(setEmojiList, null, 2));

  if (setEmojiList && setEmojiList.length > 0) {
    console.log(`\n✅ 解析成功,共 ${setEmojiList.length} 个贴表情`);
  } else {
    console.log('\n⚠️  未解析出贴表情(该列可能为空,或 schema 不匹配)');
  }

  db.close();
}

main().catch(console.error);
