/** 验证 ProfileInfoDb.botUids() / UserProfile.isBot。 */
import { loadNative } from '@weq/native';
import { ProfileInfoDb } from '../src/profile/profile_info';
import { testEnv, qqDbPath } from '@weq/testkit';

async function main() {
  const native = loadNative();
  const db = new ProfileInfoDb(native.ntHelper, {
    dbPath: qqDbPath('profile_info.db'),
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  const t0 = process.hrtime.bigint();
  const bots = await db.botUids();
  console.log(`botUids() → ${bots.size} bots in ${Number(process.hrtime.bigint() - t0) / 1e6}ms`);
  for (const uid of bots) {
    const p = await db.getProfile(uid);
    console.log(`  isBot=${p?.isBot} botType=${p?.extInfo?.botType} ${p?.nick} (uin=${p?.uin})`);
  }
  const human = await db.getProfile('u_mGIBTBW7gF4Wocw8zapc6w');
  console.log(`\ncontrol human: isBot=${human?.isBot} nick=${human?.nick}`);
  db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
