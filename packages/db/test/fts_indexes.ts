/**
 * Check indexes for FTS databases.
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const NT_DB_DIR = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db`;

async function check(name: string, tableName: string) {
  const native = loadNative();
  const dbPath = `${NT_DB_DIR}\\${name}.db`;
  const db = new QqDb(native.ntHelper, {
    dbPath,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    console.log(`\n--- [${name}.db] ---`);
    const tableInfo = await db.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}';`);
    console.log(`Schema: ${tableInfo[0]?.[0]}`);

    const indexes = await db.query(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='${tableName}';`);
    console.log(`Found ${indexes.length} indexes:`);
    indexes.forEach(idx => console.log(`  - ${idx[0]}: ${idx[1]}`));
  } catch (e) {
    console.log(`Failed to check ${name}:`, e.message);
  } finally {
    db.close();
  }
}

async function main() {
  await check('buddy_msg_fts', 'buddy_msg_fts');
  await check('group_msg_fts', 'group_msg_fts');
}

main().catch(console.error);
