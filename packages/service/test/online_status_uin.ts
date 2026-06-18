/**
 * Service integration test: fetch online status for a user by UIN.
 *
 * The online-status table in misc.db is keyed by uid, so we first resolve
 * uin -> uid through nt_msg.db's nt_uid_mapping_table, then call the service.
 */

import { loadNative } from '@weq/native';
import { MiscDb, UidMappingDb, UidMap } from '@weq/db';
import { OnlineStatusService } from '../src/account/online_status';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const BASE = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db`;
const MISC_DB_PATH = `${BASE}\\misc.db`;
const NT_MSG_DB_PATH = `${BASE}\\nt_msg.db`;

const TARGET_UIN = '2793172767';
const ALGO = { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' } as const;

async function main() {
  const native = loadNative();

  const mappingDb = new UidMappingDb(native.ntHelper, {
    dbPath: NT_MSG_DB_PATH,
    key: KEY,
    algo: ALGO,
  });

  const miscDb = new MiscDb(native.ntHelper, {
    dbPath: MISC_DB_PATH,
    key: KEY,
    algo: ALGO,
  });

  try {
    const map = UidMap.from(await mappingDb.listAll());
    const uid = map.uidByUin(BigInt(TARGET_UIN));
    console.log(`[test:status-uin] uin ${TARGET_UIN} -> uid ${uid ?? '(not found)'}`);
    if (!uid) {
      console.log('[test:status-uin] uin not present in uid mapping table.');
      return;
    }

    const service = new OnlineStatusService({ misc: miscDb } as any);
    const formatted = await service.getOnlineStatus(uid);
    if (formatted) {
      console.log('[test:status-uin] Formatted Result:');
      console.log(JSON.stringify(formatted, null, 2));
    } else {
      console.log('[test:status-uin] No status found for this uid.');
    }
  } catch (err) {
    console.error('[test:status-uin] Failed:', err);
  } finally {
    miscDb.close();
    mappingDb.close();
  }
}

main().catch((e) => {
  console.error('[test:status-uin] failed:', e);
  process.exit(1);
});
