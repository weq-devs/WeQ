/**
 * 验证 21000.ts 正式 schema 能否正确解码真实 blob。
 * Run:  pnpm tsx ./packages/db/test/verify_21000_schema.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { ProtoMsg } from '@weq/codec';
import { ProfileExtBody } from '@weq/codec/proto/profile/21000';
import { testEnv } from '@weq/testkit';

const codec = new ProtoMsg(ProfileExtBody);

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.profileDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const rows = await db.query(
    `SELECT "1002","20002","21000" FROM "profile_info_v6"
     WHERE "20072" IS NOT NULL AND "21000" IS NOT NULL
     ORDER BY length("21000") DESC LIMIT 6`,
  );

  for (const [uin, nick, blob] of rows) {
    if (!(blob instanceof Uint8Array)) continue;
    const d = codec.decode(blob).ext;
    console.log(`\n════ ${nick} (uin=${uin}) ════`);

    const marks = d?.interactMarks?.marks ?? [];
    console.log(`  互动标识(${marks.length}):`);
    for (const m of marks) {
      console.log(`    ${m.type ?? '?'} markId=${m.markId} icon=${m.smallIcon?.slice(0, 60)}`);
    }

    const priv = d?.privilege?.container;
    const opened = priv?.opened ?? [];
    const unopened = priv?.unopened ?? [];
    console.log(`  特权: 已开通${opened.length} / 未开通${unopened.length}`);
    for (const p of opened) {
      console.log(`    [开] biz=${p.bizId} lv=${p.level} icon=${(p.iconUrl || p.iconUrlAlt)?.slice(0, 70)}`);
    }

    const ext = d?.extInfo;
    console.log(`  机型=${ext?.deviceCode ?? ''}  学校=${ext?.school ?? ''}`);
    console.log(`  兴趣(${ext?.interests?.tags?.length ?? 0}): ${(ext?.interests?.tags ?? []).join(' / ')}`);

    const photos = d?.album?.container?.photos ?? [];
    console.log(`  相册(${photos.length}):`);
    photos.slice(0, 2).forEach((ph, i) => {
      const big = ph.sizes?.find((s) => s.size === 2)?.url ?? ph.sizes?.[0]?.url;
      console.log(`    #${i} id=${ph.photoId?.slice(0, 20)} time=${ph.time} url=${big}`);
    });
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
