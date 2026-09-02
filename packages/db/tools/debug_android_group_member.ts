/**
 * 诊断安卓 group_info.db 里 group_member3 的 64016 字段分布。
 *
 * Run: pnpm --filter @weq/db tools:debug-android-group-member
 *      WEQ_TEST_ANDROID_ROOT 指向 nt_qq_<hash> 目录
 */

import { loadNative } from '@weq/native';
import { androidBackup } from '@weq/testkit';
import { QqDb } from '../src/qq_db';

const ANDROID_DIR =
  process.argv[2] ??
  process.env.WEQ_TEST_ANDROID_ROOT ??
  'D:\\estkim\\com.tencent.mobileqq\\databases\\nt_db\\nt_qq_14d6c6a49c6ce9be5ca03fc736bee8da';

async function main() {
  const native = loadNative();
  const nt = native.ntHelper;

  const backup = androidBackup(ANDROID_DIR);
  console.log('[diag] uid :', backup.uid);
  console.log('[diag] key :', backup.key);

  const dbPath = backup.dbPath('group_info.db');
  console.log('[diag] db  :', dbPath);

  const probe = await nt.testDatabaseKey(dbPath, backup.key);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error(`密钥校验失败: ${JSON.stringify(probe)}`);
  }
  console.log('[diag] algo:', probe.pageHmacAlgorithm, '/', probe.kdfHmacAlgorithm);

  const db = new QqDb(nt, {
    dbPath,
    key: backup.key,
    algo: { pageHmacAlgorithm: probe.pageHmacAlgorithm, kdfHmacAlgorithm: probe.kdfHmacAlgorithm },
  });

  try {
    // 1. 表结构
    const schema = await db.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='group_member3'",
      [],
    );
    console.log('\n[diag] group_member3 schema:');
    console.log(schema[0]?.[0] ?? '(not found)');

    // 2. 64016 字段分布（全表）
    const dist = await db.query(
      'SELECT "64016", COUNT(*) as cnt FROM group_member3 GROUP BY "64016" ORDER BY cnt DESC',
      [],
    );
    console.log('\n[diag] 64016 value distribution:');
    for (const row of dist) {
      console.log(`  64016=${row[0]}  count=${row[1]}`);
    }

    // 3. 挑一个成员最多的群，比对有无 64016 过滤的差异
    const top = await db.query(
      'SELECT "60001", COUNT(*) as cnt FROM group_member3 GROUP BY "60001" ORDER BY cnt DESC LIMIT 3',
      [],
    );
    console.log('\n[diag] top groups by total member rows:');
    for (const row of top) {
      const gc = row[0];
      if (gc == null) continue;
      const total = row[1];
      const active = await db.query(
        'SELECT COUNT(*) FROM group_member3 WHERE "60001" = ? AND "64016" = 0',
        [gc],
      );
      console.log(`  group=${gc}  total=${total}  where_64016=0: ${active[0]?.[0]}`);
    }

    // 4. 看一个实际样本行的 64016 值
    const sample = await db.query('SELECT "60001","1000","64016" FROM group_member3 LIMIT 10', []);
    console.log('\n[diag] sample rows (groupCode / uid / 64016):');
    for (const row of sample) {
      console.log(`  group=${row[0]}  uid=${row[1]}  64016=${row[2]}`);
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);
