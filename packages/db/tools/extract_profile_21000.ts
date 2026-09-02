/**
 * 从 profile_info_v6 的 21000 列，挑几个好友，抽出「有价值」的人味字段供人工验证：
 *   互动标识(类型+等级+图标) / 特权列表(图标URL透传) / 教育经历 / 所在地 / 兴趣标签 / QQ空间相册
 *
 * Run:  pnpm tsx ./packages/db/tools/extract_profile_21000.ts
 */

import { loadNative } from '@weq/native';
import { QqDb } from '../src/qq_db';
import { decode } from '@weq/codec/raw';
import type { RawField, Guess } from '@weq/codec/raw';
import { testEnv } from '@weq/testkit';

const TABLE = 'profile_info_v6';

function isBlob(v: unknown): v is Uint8Array {
  return v instanceof Uint8Array;
}

/** 取一个字段的最佳 guess；按 kind 取值 */
function g0(f: RawField | undefined): Guess | undefined {
  return f?.guesses[0];
}
function asNested(f: RawField | undefined): RawField[] | undefined {
  const g = g0(f);
  return g?.kind === 'len-nested' ? g.value : undefined;
}
function asStr(f: RawField | undefined): string | undefined {
  const g = g0(f);
  return g?.kind === 'len-utf8' ? g.value : undefined;
}
function asInt(f: RawField | undefined): number | undefined {
  const g = g0(f);
  if (g?.kind === 'varint-uint64' || g?.kind === 'i64-fixed') return Number(g.value);
  if (g?.kind === 'i32-fixed') return Number(g.value);
  if (g?.kind === 'varint-timestamp-ms') return g.value.getTime();
  if (g?.kind === 'varint-timestamp-sec') return Math.floor(g.value.getTime() / 1000);
  // 小整数 0/1 会被 raw decoder 判成 bool，特权 bizId=1(超会) 就是这种
  if (g?.kind === 'varint-bool') return g.value ? 1 : 0;
  return undefined;
}
/** 一个 nested 下所有指定 tag 的字段(repeated) */
function children(fields: RawField[], tag: number): RawField[] {
  return fields.filter((f) => f.tag === tag);
}
function child(fields: RawField[], tag: number): RawField | undefined {
  return fields.find((f) => f.tag === tag);
}

interface Extracted {
  uid: string;
  uin: unknown;
  nick: string;
  interactMarks: Array<{ type?: string; level?: number; iconTemplate?: string }>;
  privileges: Array<{
    bizId?: number;
    level?: number;
    opened?: boolean;
    iconUrl?: string;
    jumpUrl?: string;
  }>;
  education: {
    school?: string;
    degree?: string;
    country?: string;
    province?: string;
    city?: string;
    address?: string;
    zip?: string;
  };
  interests: string[];
  albumPhotos: Array<{ hashUrl?: string; time?: number; sizes: number[] }>;
}

function extract(uid: string, uin: unknown, nick: string, blob: Uint8Array): Extracted {
  const out: Extracted = {
    uid,
    uin,
    nick,
    interactMarks: [],
    privileges: [],
    education: {},
    interests: [],
    albumPhotos: [],
  };
  const top = decode(blob);
  const root = asNested(top[0]); // 钻进 #21000
  if (!root) return out;

  // --- #22003 互动标识 ---
  for (const mark of children(root, 22003)) {
    const m = asNested(mark);
    if (!m) continue;
    for (const n of children(m, 31000)) {
      const nn = asNested(n);
      if (!nn) continue;
      out.interactMarks.push({
        type: asStr(child(nn, 31024)),
        level: asInt(child(nn, 31002)),
        iconTemplate: asStr(child(nn, 31019)) ?? asStr(child(nn, 31015)),
      });
    }
  }

  // --- #22004 特权 ---
  for (const priv of children(root, 22004)) {
    const p = asNested(priv);
    if (!p) continue;
    const v59 = asNested(child(p, 20059));
    if (!v59) continue;
    // 20432=已开通, 20433=未开通；都抽出来透传
    for (const tag of [20432, 20433]) {
      for (const item of children(v59, tag)) {
        const it = asNested(item);
        if (!it) continue;
        out.privileges.push({
          bizId: asInt(child(it, 20447)),
          level: asInt(child(it, 20448)),
          opened: tag === 20432,
          iconUrl: asStr(child(it, 20444)) || asStr(child(it, 20442)),
          jumpUrl: asStr(child(it, 20441)),
        });
      }
    }
  }

  // --- #22005 扩展资料 ---
  for (const ext of children(root, 22005)) {
    const e = asNested(ext);
    if (!e) continue;
    out.education = {
      school: asStr(child(e, 20026)),
      degree: asStr(child(e, 20023)),
      country: asStr(child(e, 20027)),
      province: asStr(child(e, 20028)),
      city: asStr(child(e, 20036)),
      address: asStr(child(e, 20030)),
      zip: asStr(child(e, 20029)),
    };
    const tags = asNested(child(e, 20041));
    if (tags)
      for (const t of children(tags, 20410)) {
        const s = asStr(t);
        if (s) out.interests.push(s);
      }
  }

  // --- #22009 QQ空间相册 ---
  for (const alb of children(root, 22009)) {
    const a = asNested(alb);
    if (!a) continue;
    const wrap = asNested(child(a, 20066));
    if (!wrap) continue;
    for (const photo of children(wrap, 20461)) {
      const ph = asNested(photo);
      if (!ph) continue;
      // 尺寸变体在 20473 包装里，一张照片多条(2/3/4)
      const sizes: number[] = [];
      for (const sw of children(ph, 20473)) {
        const s = asNested(sw);
        const sz = asInt(child(s ?? [], 20481));
        if (sz !== undefined) sizes.push(sz);
      }
      out.albumPhotos.push({
        hashUrl: asStr(child(ph, 20471)),
        time: asInt(child(ph, 20472)),
        sizes,
      });
    }
  }

  return out;
}

function printOne(e: Extracted): void {
  console.log(`\n════════ ${e.nick}  (uin=${e.uin}, uid=${e.uid}) ════════`);

  console.log(`\n  【互动标识】(${e.interactMarks.length})`);
  for (const m of e.interactMarks) {
    console.log(`    - ${m.type ?? '?'}  等级=${m.level ?? '?'}`);
    if (m.iconTemplate) console.log(`        icon: ${m.iconTemplate}`);
  }

  console.log(`\n  【特权列表】(${e.privileges.length})  ← URL 透传给前端显示`);
  for (const p of e.privileges) {
    console.log(
      `    - bizId=${p.bizId ?? '?'}  等级=${p.level ?? '-'}  ${p.opened ? '已开通' : '未开通'}`,
    );
    if (p.iconUrl) console.log(`        icon: ${p.iconUrl}`);
    if (p.jumpUrl) console.log(`        jump: ${p.jumpUrl.slice(0, 100)}`);
  }

  console.log(`\n  【教育/资料】`);
  const ed = e.education;
  console.log(
    `    学校=${ed.school ?? ''}  学历=${ed.degree ?? ''}  国=${ed.country ?? ''} 省=${ed.province ?? ''} 市=${ed.city ?? ''}`,
  );
  if (ed.address || ed.zip) console.log(`    地址=${ed.address ?? ''}  邮编=${ed.zip ?? ''}`);

  console.log(`\n  【兴趣标签】(${e.interests.length})  ${e.interests.join(' / ')}`);

  console.log(`\n  【QQ空间相册】(${e.albumPhotos.length} 张)`);
  e.albumPhotos.slice(0, 6).forEach((ph, i) => {
    const t = ph.time ? new Date(ph.time * 1000).toISOString().slice(0, 10) : '?';
    console.log(`    #${i} sizes=[${ph.sizes.join(',')}] time=${t}  ${ph.hashUrl?.slice(0, 80)}`);
  });
  if (e.albumPhotos.length > 6) console.log(`    …还有 ${e.albumPhotos.length - 6} 张`);
}

async function main(): Promise<void> {
  const native = loadNative();
  const db = new QqDb(native.ntHelper, {
    dbPath: testEnv.profileDbPath,
    key: testEnv.key,
    algo: { pageHmacAlgorithm: 'SHA1', kdfHmacAlgorithm: 'SHA512' },
  });

  // 好友(20072 非空) 且 21000 非空，优先挑内容丰富的(blob 大)
  const rows = await db.query(
    `SELECT "1000","1002","20002","21000"
     FROM "${TABLE}"
     WHERE "20072" IS NOT NULL AND "21000" IS NOT NULL
     ORDER BY length("21000") DESC
     LIMIT 6`,
  );
  console.log(`挑到 ${rows.length} 个好友(21000 内容最丰富的)`);

  for (const r of rows) {
    const uid = String(r[0] ?? '');
    const uin = r[1];
    const nick = String(r[2] ?? '');
    const blob = r[3];
    if (!isBlob(blob)) continue;
    printOne(extract(uid, uin, nick, blob));
  }

  db.close();
}

main().catch((e) => {
  console.error('[extract-profile-21000] failed:', e);
  process.exit(1);
});
