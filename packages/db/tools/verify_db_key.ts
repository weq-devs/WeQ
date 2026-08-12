/**
 * 验证单个数据库文件与密钥是否匹配。
 *
 * 用法：
 *   pnpm --filter @weq/db tools:verify-db-key <dbPath> <key> [algo]
 *
 * algo 可选值：
 *   standard  (默认) SHA1/SHA512  — nt_msg.db / profile_info.db 等
 *   gpro                          — gpro_v1-6_*.db (kdf_iter=4000, hmac=OFF)
 *
 * 示例：
 *   pnpm --filter @weq/db tools:verify-db-key \
 *     ".../nt_msg.db" "64d98694043be84bd08855142cb77d46"
 *
 *   pnpm --filter @weq/db tools:verify-db-key \
 *     ".../gpro_v1-6_u_xxx.db" "2a4e04f77fd4ab2f4a42717e3e69e3d3" gpro
 */

import { loadNative } from '@weq/native';
import type { DatabaseAlgorithms } from '@weq/native';

async function main() {
  const [, , dbPath, key, algoArg] = process.argv;
  if (!dbPath || !key) {
    console.error('用法: tsx verify_db_key.ts <dbPath> <key> [standard|gpro]');
    process.exit(1);
  }

  const native = loadNative();
  const nt = native.ntHelper;

  if (algoArg === 'gpro') {
    // gpro uses kdf_iter=4000, cipher_use_hmac=OFF — testDatabaseKey probes
    // standard HMAC params and will always fail for gpro even with correct key.
    // Use executeSqlWithKey with gpro's actual algo params instead.
    const algo: DatabaseAlgorithms = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA1' };
    try {
      // First try with a dummy algo just to open — gpro has hmac=OFF so neither
      // SHA1/SHA512 combo is "right", but the native layer may still open it.
      // Fallback: run PRAGMA to confirm the db is readable.
      await nt.executeSqlWithKey(dbPath, 'PRAGMA kdf_iter = 4000', key, algo);
      const rows = await nt.executeSqlWithKey(dbPath, 'SELECT count(*) FROM sqlite_master', key, algo);
      console.log(`OK    gpro  tables=${rows[0]?.[0] ?? '?'}`);
      console.log(`      ${dbPath}`);
    } catch (e) {
      // Try the other combo
      const algo2: DatabaseAlgorithms = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' };
      try {
        await nt.executeSqlWithKey(dbPath, 'PRAGMA kdf_iter = 4000', key, algo2);
        const rows = await nt.executeSqlWithKey(dbPath, 'SELECT count(*) FROM sqlite_master', key, algo2);
        console.log(`OK    gpro(SHA512)  tables=${rows[0]?.[0] ?? '?'}`);
        console.log(`      ${dbPath}`);
      } catch (e2) {
        console.log(`FAIL  密钥不匹配 (gpro)`);
        console.log(`      ${dbPath}`);
        console.log(`      err: ${e2 instanceof Error ? e2.message : e2}`);
        process.exit(1);
      }
    }
    return;
  }

  // Standard path: use testDatabaseKey probe
  const result = await nt.testDatabaseKey(dbPath, key);
  if (result.success) {
    console.log(`OK    pageHmac=${result.pageHmacAlgorithm ?? '?'}  kdfHmac=${result.kdfHmacAlgorithm ?? '?'}`);
    console.log(`      ${dbPath}`);
  } else {
    console.log(`FAIL  密钥不匹配`);
    console.log(`      ${dbPath}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
