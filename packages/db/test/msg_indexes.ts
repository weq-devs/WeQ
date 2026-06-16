/**
 * List indexes for group_msg_table.
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const MSG_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\nt_msg.db`;

async function main() {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: MSG_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    console.log('[test:msg-indexes] Checking indexes for group_msg_table...');
    const indexes = await db.query(
      "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='group_msg_table';"
    );
    
    console.log(`[test:msg-indexes] Found ${indexes.length} indexes:`);
    indexes.forEach((row, i) => {
      console.log(`\n${i + 1}. Name: ${row[0]}`);
      console.log(`   SQL: ${row[1]}`);
    });

    // Also check the table schema itself to see primary keys / unique constraints
    console.log('\n[test:msg-indexes] Table Schema:');
    const table = await db.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='group_msg_table';"
    );
    console.log(table[0]?.[0]);

  } catch (err) {
    console.error('[test:msg-indexes] Failed:', err);
  } finally {
    db.close();
  }
}

main().catch(console.error);
