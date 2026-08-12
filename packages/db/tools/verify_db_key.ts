/**
 * 验证数据库路径 + 密钥是否匹配，并打印探测到的加密算法。
 *
 * 用法：
 *   pnpm --filter @weq/db tools:verify-db-key <数据库路径> <密钥>
 *
 * 例：
 *   pnpm --filter @weq/db tools:verify-db-key D:\QQ\nt_qq\nt_db\nt_msg.db abc123
 *
 * 底层调用 nt_helper 的 testDatabaseKey，会自动探测页 HMAC / KDF 算法，
 * 无需预先知道 algo，也不限制密钥长度或格式。
 */

import { loadNative } from '@weq/native';

const [, , dbPath, key] = process.argv;

if (!dbPath || !key) {
  console.error('用法: verify_db_key <数据库路径> <密钥>');
  process.exit(1);
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  console.log(`数据库: ${dbPath}`);
  console.log(`密钥:   ${key}`);
  console.log('探测中…\n');

  const result = await nt.testDatabaseKey(dbPath, key);

  if (result.success) {
    console.log('结果: 密钥正确 ✓');
    console.log(`  pageHmacAlgorithm = ${result.pageHmacAlgorithm}`);
    console.log(`  kdfHmacAlgorithm  = ${result.kdfHmacAlgorithm}`);
  } else {
    console.log('结果: 密钥错误或数据库不可读 ✗');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('[verify-db-key] 失败:', e);
  process.exit(1);
});
