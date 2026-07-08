/** Probe nt_msg.db for triggers / FTS virtual tables touching c2c_msg_table & recent_contact_v3_table. */
import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';

const UIN_ME = process.env.WEQ_TEST_UIN ?? '1707889225';
const KEY = process.env.WEQ_TEST_DB_KEY ?? '^;<kXZ;RI[@]yTD<';
const MSG_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN_ME}\\nt_qq\\nt_db\\nt_msg.db`;
const PROFILE_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN_ME}\\nt_qq\\nt_db\\profile_info.db`;
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

async function main() {
  const db = new QqDb(loadNative().ntHelper, { dbPath: MSG_DB_PATH, key: KEY, algo: ALGO });
  const pdb = new QqDb(loadNative().ntHelper, { dbPath: PROFILE_DB_PATH, key: KEY, algo: ALGO });
  console.log('===== VIRTUAL / fts / pinyin tables anywhere =====');
  const virt = await db.query(
    `SELECT type, name, tbl_name FROM sqlite_master
      WHERE sql LIKE '%VIRTUAL%' OR sql LIKE '%pinyin%' OR name LIKE '%fts%'`,
  );
  for (const r of virt) console.log(`  ${String(r[0]).padEnd(8)} ${r[1]} (on ${r[2]})`);
  console.log(`(count: ${virt.length})`);

  // Which cleanup DELETE throws? Try each in isolation (rollback via no matching row).
  const FAKE_UID = 'u_WeQ-assistant-fake01';
  const targets: Array<[string, string]> = [
    ['nt_uid_mapping_table', '48902'],
    ['c2c_msg_table', '40021'],
    ['recent_contact_v3_table', '40021'],
  ];
  console.log('\n===== probe each DELETE in nt_msg.db =====');
  for (const [table, col] of targets) {
    try {
      const n = await db.write(`DELETE FROM "${table}" WHERE "${col}" = ?`, [FAKE_UID]);
      console.log(`  ${table.padEnd(28)} OK (deleted ${n})`);
    } catch (e) {
      console.log(`  ${table.padEnd(28)} THREW: ${(e as Error).message}`);
    }
  }

  console.log('\n===== profile_info.db VIRTUAL / triggers / pinyin =====');
  const pvirt = await pdb.query(
    `SELECT type, name, tbl_name, sql FROM sqlite_master
      WHERE type='trigger' OR sql LIKE '%VIRTUAL%' OR sql LIKE '%pinyin%' OR name LIKE '%fts%'`,
  );
  for (const r of pvirt) {
    console.log(`\n  ${String(r[0]).padEnd(8)} ${r[1]} (on ${r[2]})`);
    console.log('    ' + String(r[3] ?? '').slice(0, 400).replace(/\n/g, '\n    '));
  }
  console.log(`(count: ${pvirt.length})`);

  console.log('\n===== probe each DELETE in profile_info.db =====');
  for (const [table, col] of [['profile_info_v6', '1000'], ['profile_info_public_account', '1000']] as const) {
    try {
      const n = await pdb.write(`DELETE FROM "${table}" WHERE "${col}" = ?`, [FAKE_UID]);
      console.log(`  ${table.padEnd(28)} OK (deleted ${n})`);
    } catch (e) {
      console.log(`  ${table.padEnd(28)} THREW: ${(e as Error).message}`);
    }
  }

  db.close();
  pdb.close();
}
main().catch(console.error);
