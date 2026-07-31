/**
 * 验证 21000.ts 正式 schema 能否正确解码真实 blob，重点看「个性标签」。
 *
 * Run:  pnpm tsx ./packages/db/tools/verify_21000_schema.ts            # 自动挑最肥的样本
 *       pnpm tsx ./packages/db/tools/verify_21000_schema.ts 305833380  # 指定 uin
 *
 * 取样刻意不加 `20072 IS NOT NULL`(好友) 过滤 —— 实测本机 21000 内容最丰富的一行
 * 恰恰来自非好友，加了这个条件就永远抽不到它。
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { ProtoMsg } from '@weq/codec';
import { ProfileExtBody } from '@weq/codec/proto/profile/21000';
import { testEnv } from '@weq/testkit';

const codec = new ProtoMsg(ProfileExtBody);

/** 默认抽样条数(不指定 uin 时)。 */
const SAMPLE_SIZE = 6;

/**
 * 把不可见字符显形。个性标签里塞零宽字符是常见玩法 —— 本机就有一行 10 个标签
 * 肉眼全是 `F⁻`，实际靠 U+200B/200C/200D/2060 区分。不显形就没法验证去重是否正确。
 */
function reveal(s: string): string {
  return s.replace(
    /[​-‏‪-‮⁠-⁤­﻿᠎]/g,
    (c) => `‹U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}›`,
  );
}

function printOne(uin: unknown, nick: unknown, isFriend: boolean, blob: unknown): void {
  console.log(`\n════ ${nick} (uin=${uin}, ${isFriend ? '好友' : '非好友'}) ════`);

  if (!(blob instanceof Uint8Array)) {
    console.log('  21000 = NULL —— 该行只缓存了昵称/头像等基础列。');
    console.log('  想让它有值:在 QQ 里打开一次此人的资料卡,客户端才会回写 21000。');
    return;
  }

  const d = codec.decode(blob).ext;
  if (!d) {
    console.log(`  21000 有 ${blob.length} 字节但解不出内层 —— schema 或数据异常,需排查。`);
    return;
  }

  // ---- 个性标签(#22005/#20041/#20410) ----
  const tags = d.extInfo?.interests?.tags ?? [];
  console.log(`  【个性标签】(${tags.length})`);
  for (const t of tags) {
    const shown = reveal(t);
    console.log(`    · ${shown}${shown === t ? '' : '   ← 含不可见字符'}`);
  }
  const unique = new Set(tags).size;
  if (unique !== tags.length) {
    console.log(`    ⚠ ${tags.length} 个标签里只有 ${unique} 个互不相同`);
  }

  const marks = d.interactMarks?.marks ?? [];
  console.log(`  互动标识(${marks.length}):`);
  for (const m of marks) {
    console.log(`    ${m.type ?? '?'} markId=${m.markId} icon=${m.smallIcon?.slice(0, 60)}`);
  }

  const priv = d.privilege?.container;
  const opened = priv?.opened ?? [];
  const unopened = priv?.unopened ?? [];
  console.log(`  特权: 已开通${opened.length} / 未开通${unopened.length}`);
  for (const p of opened) {
    console.log(`    [开] biz=${p.bizId} lv=${p.level} icon=${(p.iconUrl || p.iconUrlAlt)?.slice(0, 70)}`);
  }

  const ext = d.extInfo;
  const region = [ext?.country, ext?.province, ext?.city].filter(Boolean).join(' ');
  console.log(`  所在地=${region}  学校=${ext?.school ?? ''}  学历=${ext?.degree ?? ''}`);

  const photos = d.album?.container?.photos ?? [];
  console.log(`  相册(${photos.length}):`);
  photos.slice(0, 2).forEach((ph, i) => {
    const big = ph.sizes?.find((s) => s.size === 2)?.url ?? ph.sizes?.[0]?.url;
    console.log(`    #${i} id=${ph.photoId?.slice(0, 20)} time=${ph.time} url=${big}`);
  });
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.profileDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  const COLS = `"1002","20002",("20072" IS NOT NULL),"21000"`;
  const targets = process.argv.slice(2);

  if (targets.length === 0) {
    // 全表概览 —— 21000 非空的比例很低,先说清楚样本池有多大。
    const [stat] = await db.query(
      `SELECT COUNT(*), SUM("21000" IS NOT NULL), SUM(length("21000") > 50)
       FROM "profile_info_v6"`,
    );
    console.log(
      `profile_info_v6: ${stat?.[0]} 行,其中 21000 非空 ${stat?.[1]} 行,` +
        `有实质内容(>50B) ${stat?.[2]} 行`,
    );
  }

  const rows =
    targets.length > 0
      ? await db.query(
          `SELECT ${COLS} FROM "profile_info_v6"
           WHERE "1002" IN (${targets.map(() => '?').join(',')})`,
          targets,
        )
      : await db.query(
          `SELECT ${COLS} FROM "profile_info_v6"
           WHERE "21000" IS NOT NULL
           ORDER BY length("21000") DESC LIMIT ${SAMPLE_SIZE}`,
        );

  const found = new Set(rows.map((r) => String(r[0])));
  for (const t of targets) {
    if (!found.has(t)) console.log(`\n════ uin=${t} ════\n  该 uin 在 profile_info_v6 里没有行。`);
  }

  for (const [uin, nick, isFriend, blob] of rows) {
    printOne(uin, nick, Boolean(isFriend), blob);
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
