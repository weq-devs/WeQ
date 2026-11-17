/**
 * PC QQ 的 dbkey 是 16 位可打印 ASCII；手机 QQ（安卓备份目录）的是 32 位
 * 十六进制。两种都要放行，否则 32 位密钥会被当成「没填完」而被整个丢掉。
 */
const KEY_LENGTHS = [16, 32];

/** A complete key is 16 or 32 printable-ascii chars. */
export function isCompleteKey(value: string): boolean {
  return KEY_LENGTHS.includes(value.length) && /^[\x20-\x7e]+$/.test(value);
}

/** 人类可读的长度要求，给提示文案用。 */
export const KEY_LEN_HINT = KEY_LENGTHS.join(' / ');
