/**
 * 实验：往 market_emoticon_package_table 插一行「付费」表情包（247623 天使小泪，
 * feetype=2 ￥6），验证 QQ 会不会把「我没买、但库里有」的付费表情包正常显示出来
 * ——若显示成立，则印证「面板显示不需要图片密钥，密钥只在发送时向服务器索取」。
 *
 * 安全：
 *   - 写 emoji.db 前 QQ 必须完全关闭（写连接持 EXCLUSIVE 锁，QQ 在跑会被锁死/损坏）。
 *   - 克隆现有行 row0（3D萌弹PUPU鹅，官方免费包）当模板，只改 主键packId / 名字 /
 *     介绍 / 添加时间 四列，其余 28 列原样照抄——避免造出 QQ 不认的行。
 *   - QqDb.write() 内建 finally closeDb，写完即释放锁还给 QQ。
 *   - 幂等：已存在同 packId 则跳过，不覆盖。
 *   - 可还原：DELETE FROM market_emoticon_package_table WHERE "80943"='247623';
 *
 * 用法（QQ 关闭后）: pnpm tsx packages/db/test/insert_paid_pack.ts
 */

import { loadNative } from '@weq/native';
import type { SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv, qqDbPath } from '@weq/testkit';

const TABLE = 'market_emoticon_package_table';

/** 要插的付费包（取自 android.json：feetype=2 付费 ￥6）。 */
const NEW_PACK = {
  packId: '247623',
  name: '天使小泪',
  summary: '天使小泪',
  addTime: 1783068284, // android.json updateTime
};

/** 列顺序（建表顺序，32 列），供按位克隆 + 改写。 */
const COLS = [
  '80943', '80944', '80945', '80946', '80947', '80948', '80949', '80950',
  '80951', '80952', '80953', '80954', '80955', '80956', '80957', '80958',
  '80959', '80960', '80961', '80962', '80963', '80964', '80965', '80966',
  '80967', '80968', '80969', '80970', '80971', '80972', '80973', '80974',
];

async function main(): Promise<void> {
  const { ntHelper } = loadNative();
  const dbPath = qqDbPath('emoji.db');
  const key = testEnv.key;

  const probe = await ntHelper.testDatabaseKey(dbPath, key);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error('emoji.db 密钥错误或算法探测失败');
  }
  const algo = { pageHmacAlgorithm: probe.pageHmacAlgorithm, kdfHmacAlgorithm: probe.kdfHmacAlgorithm };
  const db = new QqDb(ntHelper, { dbPath, key, algo });

  try {
    // 幂等：已存在就不动。
    const dup = await db.query(`SELECT "80943" FROM "${TABLE}" WHERE "80943"=?`, [NEW_PACK.packId]);
    if (dup.length > 0) {
      console.log(`⚠️  ${NEW_PACK.packId}（${NEW_PACK.name}）已在表里，跳过插入。`);
      await dumpAll(db);
      return;
    }

    // 取一行真实模板（任意现有行即可）。
    const templates = await db.query(`SELECT ${COLS.map((c) => `"${c}"`).join(',')} FROM "${TABLE}" LIMIT 1`);
    const template = templates[0];
    if (!template) throw new Error('表里没有任何现有行可当模板');

    // 克隆模板，改 4 列。
    const values: SqlValue[] = template.slice() as SqlValue[];
    const set = (col: string, v: SqlValue): void => {
      values[COLS.indexOf(col)] = v;
    };
    set('80943', NEW_PACK.packId); // 主键 packId
    set('80947', NEW_PACK.name); // 名称
    set('80948', NEW_PACK.summary); // 介绍
    set('80963', NEW_PACK.addTime); // 添加时间

    console.log('将插入行（克隆模板 + 改 4 列）：');
    COLS.forEach((c, i) => console.log(`   ${c} = ${preview(values[i])}`));

    const placeholders = COLS.map(() => '?').join(',');
    const sql = `INSERT INTO "${TABLE}" (${COLS.map((c) => `"${c}"`).join(',')}) VALUES (${placeholders})`;
    const affected = await db.write(sql, values);
    console.log(`\n✅ 插入完成，affected=${affected}。连接已释放（锁还给 QQ）。`);

    await dumpAll(db);
    console.log('\n还原命令（若要撤销）：');
    console.log(`   DELETE FROM "${TABLE}" WHERE "80943"='${NEW_PACK.packId}';`);
  } finally {
    db.close();
  }
}

async function dumpAll(db: QqDb): Promise<void> {
  const rows = await db.query(
    `SELECT "80943","80947","80948","80949","80954","80963" FROM "${TABLE}" ORDER BY "80963" DESC`,
  );
  console.log(`\n当前表内 ${rows.length} 个表情包：`);
  for (const r of rows) {
    const t = Number(r[5]) ? new Date(Number(r[5]) * 1000).toISOString().slice(0, 10) : '?';
    console.log(`   [${r[0]}] ${r[1]} — ${r[2]}  (80949=${r[3]} 80954=${r[4]}, added ${t})`);
  }
}

function preview(val: unknown): string {
  if (val instanceof Uint8Array) return `<bytes ${val.length}>`;
  if (typeof val === 'bigint') return `${val}n`;
  return JSON.stringify(val);
}

main().catch((e) => {
  console.error('failed:', e);
  process.exit(1);
});
