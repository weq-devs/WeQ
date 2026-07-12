/**
 * Delete the fabricated "WeQ助手" test rows from nt_msg.db so a fresh run of the
 * feature (or the injection test) re-creates them cleanly.
 *
 * ⚠️ WRITES to the live nt_msg.db. Run with QQ fully closed.
 *
 * Run:  pnpm --filter @weq/db test:delete-weq-assistant
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const UIN_ME = process.env.WEQ_TEST_UIN ?? '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const MSG_DB_PATH =
  process.env.WEQ_TEST_DB_PATH ??
  `D:\\estkim\\T\\Tencent Files\\${UIN_ME}\\nt_qq\\nt_db\\nt_msg.db`;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

// uid 现在是每台机器随机生成并存在 %APPDATA%/weq/config.json 的 `weqAssistantUid`。
// 跑这个脚本清库时，用 WEQ_FAKE_UID 传入你本机那份真实 uid（下面的默认值只是旧的历史
// 硬编码值，仅对早期安装有效）。
const FAKE_UID = process.env.WEQ_FAKE_UID ?? 'u_WeQ-assistant-fake01';

async function main(): Promise<void> {
  const db = new QqDb(loadNative().ntHelper, { dbPath: MSG_DB_PATH, key: KEY, algo: ALGO });
  console.log(`[delete-weq-assistant] opening ${MSG_DB_PATH}`);
  console.log(`[delete-weq-assistant] deleting rows for uid=${FAKE_UID}\n`);

  const targets: Array<[string, string]> = [
    ['nt_uid_mapping_table', '48902'],
    ['c2c_msg_table', '40021'],
    ['recent_contact_v3_table', '40021'],
  ];

  for (const [table, col] of targets) {
    const n = await db.write(`DELETE FROM "${table}" WHERE "${col}" = ?`, [FAKE_UID]);
    console.log(`  ${table.padEnd(28)} deleted ${n}`);
  }

  db.close();
  console.log('\n[delete-weq-assistant] done.');
}

main().catch((e) => {
  console.error('[delete-weq-assistant] failed:', e);
  process.exit(1);
});
