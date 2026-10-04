/**
 * 红包请求签名（明文 `f101`）—— `hb_pc_pre_pack` / `hb_pc_detail` / `hb_pc_grab`
 * 三条命令共用同一套算法。
 *
 *   sign_input = sender.Serialize() || pack.Serialize()   两条子消息直接拼，无外层 tag/长度
 *   S1 = "8205dhf981y5c91kl"   S2 = "26zcf40fae8eghyp"
 *   f101 = MD5( MD5(sign_input || S1) || S2 )
 *
 * 两份材料是 nt_helper 的 GenerateSignatureSalt1/2 解出来的常量（私仓
 * `nt_helper/src/red_bag.rs`，与 AES key/iv 的四份材料同源，Windows / Linux 逐字节一致）。
 *
 * 固定向量（改动算法 / 材料会立刻让 `redbag.test.ts` 变红）：
 *   sign(b"nt_helper") = 5ce172c2045022421762c6cb3c92589b
 *   sign(b"")          = efabb76b09dad8ce7939971c4a86b393
 */

import { createHash } from 'node:crypto';

/** GenerateSignatureSalt1 解出的盐串。 */
export const RED_BAG_SIGN_SALT1 = '8205dhf981y5c91kl';
/** GenerateSignatureSalt2 解出的盐串。 */
export const RED_BAG_SIGN_SALT2 = '26zcf40fae8eghyp';

function md5(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('md5');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * 给红包请求算 16 字节 f101。
 *
 * signInput 是 sender 与 pack 两条子消息的 protobuf 字节**直接拼接** —— 不是外层
 * 消息的序列化结果，没有外层 tag / 长度前缀（见 redBagSignInput）。
 */
export function signRedBagRequest(signInput: Uint8Array): Uint8Array {
  const salt1 = new TextEncoder().encode(RED_BAG_SIGN_SALT1);
  const salt2 = new TextEncoder().encode(RED_BAG_SIGN_SALT2);
  return md5(md5(concat(signInput, salt1)), salt2);
}
