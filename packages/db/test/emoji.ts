/**
 * 解析 emoji.db 的 base_sys_emoji_table，导出「Unicode 字符表情」的
 * face_id ↔ emoji 映射（81214 非 0 的行）。
 *
 * 用法: pnpm tsx packages/db/test/emoji.ts
 */

import { loadNative } from '@weq/native';
import { BaseSysEmojiDb } from '../src/emoji/base_sys_emoji';

const UIN = '1707889225';
const KEY = '^;<kXZ;RI[@]yTD<';
const EMOJI_DB_PATH = `D:\\estkim\\T\\Tencent Files\\${UIN}\\nt_qq\\nt_db\\emoji.db`;

async function main(): Promise<void> {
  const { ntHelper } = loadNative();

  console.log('[emoji] Opening:', EMOJI_DB_PATH);
  const probe = await ntHelper.testDatabaseKey(EMOJI_DB_PATH, KEY);
  if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
    throw new Error('emoji.db 密钥错误或算法探测失败');
  }
  const algo = {
    pageHmacAlgorithm: probe.pageHmacAlgorithm,
    kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
  };

  const db = new BaseSysEmojiDb(ntHelper, { dbPath: EMOJI_DB_PATH, key: KEY, algo });

  const all = await db.listAll();
  const unicode = await db.listUnicodeEmojis();
  console.log(
    `[emoji] base_sys_emoji_table 共 ${all.length} 行，其中 81214 非 0 的 Unicode 表情 ${unicode.length} 个\n`,
  );

  // 逐行对比：faceId(81214) 与 String.fromCodePoint(faceId)、desc 三者关系。
  for (const e of unicode) {
    let fromCp = '';
    try {
      fromCp = String.fromCodePoint(e.unicodeId);
    } catch {
      fromCp = '(invalid)';
    }
    console.log(
      `faceId=${e.unicodeId}\tcp=${fromCp}\tdesc=${JSON.stringify(e.desc)}\temojiType=${e.emojiType}\tid=${e.id}`,
    );
  }

  // 生成可直接粘贴到前端的硬编码映射（faceId → emoji 字符）。
  // desc 多为 "[xxx]" 外显文字而非 emoji 本身，故统一用 code point 还原字形，
  // 只有 code point 还原失败时才退回 desc。
  const map: Record<number, string> = {};
  for (const e of unicode) {
    let glyph: string;
    try {
      glyph = String.fromCodePoint(e.unicodeId);
    } catch {
      glyph = e.desc;
    }
    if (glyph) map[e.unicodeId] = glyph;
  }
  console.log('\n--- 硬编码映射（faceId → emoji），可直接粘贴 ---');
  console.log(JSON.stringify(map));
  console.log(`\n[emoji] 映射条目数: ${Object.keys(map).length}`);

  db.close();
}

main().catch((e) => {
  console.error('[emoji] failed:', e);
  process.exit(1);
});
