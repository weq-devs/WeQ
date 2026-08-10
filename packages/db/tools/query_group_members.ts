/**
 * 查询指定群的所有成员（含已退群）
 * Run: pnpm --filter @weq/db tools:query-group-members
 */

import { loadNative } from '@weq/native';
import { androidBackup } from '@weq/testkit';
import { QqDb } from '../src/qq_db';

const ANDROID_DIR =
  process.argv[2] ??
  'D:\\estkim\\com.tencent.mobileqq\\databases\\nt_db\\nt_qq_14d6c6a49c6ce9be5ca03fc736bee8da';

const GROUP_CODE = process.argv[3] ?? '673646675';

async function main() {
  const native = loadNative();
  const nt = native.ntHelper;

  const backup = androidBackup(ANDROID_DIR);
  const dbPath = backup.dbPath('group_info.db');

  const probe = await nt.testDatabaseKey(dbPath, backup.key);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error(`密钥校验失败: ${JSON.stringify(probe)}`);
  }

  const db = new QqDb(nt, {
    dbPath,
    key: backup.key,
    algo: { pageHmacAlgorithm: probe.pageHmacAlgorithm, kdfHmacAlgorithm: probe.kdfHmacAlgorithm },
  });

  try {
    // 现在还在群里（64016=0 或 NULL）
    const active = await db.query(
      `SELECT "1000","1002","64003","20002","64010","64016","64007" FROM group_member3
       WHERE "60001" = ? AND ("64016" = 0 OR "64016" IS NULL)
       ORDER BY "64010" DESC, "64007" ASC`,
      [BigInt(GROUP_CODE)],
    );

    console.log(`\n=== 群 ${GROUP_CODE} 现在在群里的成员 (${active.length} 人) ===`);
    console.log('uid                                    | uin        | card / nick        | adminFlag | joined');
    console.log('---------------------------------------|------------|--------------------|-----------|---------');
    for (const r of active) {
      const uid = String(r[0] ?? '').padEnd(38);
      const uin = String(r[1] ?? '').padEnd(10);
      const name = (String(r[2] || r[3] || '')).slice(0, 18).padEnd(18);
      const admin = String(r[4] ?? 0).padEnd(9);
      const joined = r[6] ? new Date(Number(r[6]) * 1000).toISOString().slice(0, 10) : '?';
      console.log(`${uid} | ${uin} | ${name} | ${admin} | ${joined}`);
    }

    // 全部相关（含已退群 64016=1）
    const all = await db.query(
      `SELECT "1000","1002","64003","20002","64010","64016","64007" FROM group_member3
       WHERE "60001" = ?
       ORDER BY "64016" ASC, "64010" DESC`,
      [BigInt(GROUP_CODE)],
    );

    const left = all.filter(r => r[5] === 1 || (r[5] !== 0 && r[5] !== null));
    if (left.length > 0) {
      console.log(`\n=== 已退群成员 (${left.length} 人) ===`);
      for (const r of left) {
        const uid = String(r[0] ?? '');
        const uin = String(r[1] ?? '');
        const name = String(r[2] || r[3] || '');
        console.log(`  uid=${uid}  uin=${uin}  name=${name}  64016=${r[5]}`);
      }
    }

    console.log(`\n合计：总行数=${all.length}，在群=${active.length}，已退=${left.length}`);
  } finally {
    db.close();
  }
}

main().catch(console.error);
