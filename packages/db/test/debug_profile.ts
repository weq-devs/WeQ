/**
 * Debug profile_info_v6 columns.
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { testEnv, qqDbPath } from '@weq/testkit';

const KEY = testEnv.key;
const PROFILE_DB_PATH = qqDbPath('profile_info.db');

async function main() {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: PROFILE_DB_PATH,
    key: KEY,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  try {
    const targetUid = 'u_-5G5s2u1eRSwl5MPLaWV2Q';
    const rows = await db.query(`SELECT * FROM profile_info_v6 WHERE "1000" = ?`, [targetUid]);
    if (rows.length > 0) {
        console.log('Row headers would be useful but QqDb.query returns positional values.');
        // Let's query specific columns including 20014
        const detail = await db.query(`SELECT "1000", "20002", "20014" FROM profile_info_v6 WHERE "1000" = ?`, [targetUid]);
        console.log('Detail (uid, nick, 20014):', detail[0]);
    }
  } finally {
    db.close();
  }
}

main().catch(console.error);
