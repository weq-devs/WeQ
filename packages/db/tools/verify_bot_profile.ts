/** 验证 BotProfileDb 解析 profile_info_adelie。 */
import { loadNative } from '@weq/native';
import { BotProfileDb } from '../src/profile/bot_profile';
import { testEnv, qqDbPath } from '@weq/testkit';

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);

async function main() {
  const native = loadNative();
  const db = new BotProfileDb(native.ntHelper, {
    dbPath: qqDbPath('profile_info.db'),
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });
  for (const p of await db.listBotProfiles()) {
    console.log(`\n########## ${p.nick} ##########`);
    console.log(
      json({ ...p, commands: p.commands.slice(0, 3), description: p.description.slice(0, 60) }),
    );
    console.log(`  (commands total: ${p.commands.length})`);
  }
  db.close();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
