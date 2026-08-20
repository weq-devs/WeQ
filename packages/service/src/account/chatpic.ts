/**
 * 安卓 QQ 本地图片缓存（chatpic）寻址。
 *
 * 手机 QQ 的聊天图片缓存在
 *   /sdcard/Android/data/com.tencent.mobileqq/Tencent/MobileQQ/chatpic
 * 下按三个目录存放：chatraw（原图）/ chatimg（普通图）/ chatthumb（缩略图）。
 * 文件名与目录都来自 md5：
 *
 *   url      = `${folder}:${md5}`  （folder ∈ chatraw / chatimg / chatthumb）
 *   crc      = CRC64(url)，**有符号** BigInt —— 实测 QQ 文件名带负号，
 *              所以不能做无符号化（反射多项式 0x95AC9329AC4BC9B5，初值
 *              -1n，无最终异或；与 QQDecrypt 文档站的实现一致）
 *   filename = `Cache_${crc.toString(16)}`
 *   subdir   = filename 最后 3 个字符
 *   相对路径 = `${folder}/${subdir}/${filename}`
 *
 * 用同一个 md5 在三个目录里各算一次，得到三个不同文件名——寻址时逐个
 * 探测，哪个存在用哪个。
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** chatpic 根目录下必须齐全的三个子目录。 */
export const CHATPIC_FOLDERS = ['chatraw', 'chatimg', 'chatthumb'] as const;

export type ChatpicFolder = (typeof CHATPIC_FOLDERS)[number];

/** CRC64 反射查表（与 QQCachePath.vue / QQ 本体一致）。 */
const CRC64_TABLE: bigint[] = (() => {
  const table = new Array<bigint>(256);
  for (let i = 0; i < 256; i++) {
    let bf = BigInt(i);
    for (let j = 0; j < 8; j++) {
      if ((bf & 1n) !== 0n) bf = (bf >> 1n) ^ -7661587058870466123n;
      else bf >>= 1n;
    }
    table[i] = bf;
  }
  return table;
})();

function crc64(s: string): bigint {
  let v = -1n;
  for (let i = 0; i < s.length; i++) {
    const idx = Number((BigInt(s.charCodeAt(i)) ^ v) & 0xffn);
    v = CRC64_TABLE[idx]! ^ (v >> 8n);
  }
  return v;
}

/** 单个目录下的缓存文件名（`Cache_<hex>`，可能带负号）。 */
export function chatpicFileName(folder: ChatpicFolder, md5: string): string {
  return `Cache_${crc64(`${folder}:${md5}`).toString(16)}`;
}

/** 三个目录各自的相对路径（相对 chatpic 根目录）。 */
export function chatpicRelPaths(md5: string): Record<ChatpicFolder, string> {
  return {
    chatraw: relFor('chatraw', md5),
    chatimg: relFor('chatimg', md5),
    chatthumb: relFor('chatthumb', md5),
  };
}

function relFor(folder: ChatpicFolder, md5: string): string {
  const name = chatpicFileName(folder, md5);
  return `${folder}/${name.slice(-3)}/${name}`;
}

/**
 * 在已导入的 chatpic 根目录里找一个 md5 对应的缓存文件。
 * 优先原图（chatraw），其次普通图（chatimg），最后缩略图（chatthumb）——
 * 能显示出来比清晰度重要，所以不放第一个就放弃。
 */
export function resolveChatpicFile(root: string, md5: string): string | null {
  if (!md5 || !root) return null;
  const paths = chatpicRelPaths(md5);
  const order: ChatpicFolder[] = ['chatraw', 'chatimg', 'chatthumb'];
  for (const folder of order) {
    const abs = join(root, paths[folder]);
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  }
  return null;
}

/** 校验一个目录能否当 chatpic 根目录（三个子目录必须齐全）。 */
export function validateChatpicRoot(root: string): { ok: true } | { ok: false; error: string } {
  if (!root) return { ok: false, error: '未选择目录' };
  if (!existsSync(root)) return { ok: false, error: `目录不存在：${root}` };
  const missing = CHATPIC_FOLDERS.filter((f) => {
    try {
      return !statSync(join(root, f)).isDirectory();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) {
    return {
      ok: false,
      error: `该目录不是完整的 chatpic 备份：缺少 ${missing.join('、')} 子目录（导入前请确认已经备份整个 chatpic 目录）。`,
    };
  }
  return { ok: true };
}
