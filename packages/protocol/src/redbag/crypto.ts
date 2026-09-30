/**
 * 红包 payload 的对称加密（`trpc.qqhb.qqhb_proxy.Handler.sso_handle`）。
 *
 * 每个请求/响应各带一个 16 字节随机 **salt**，AES-128-CBC 的 key / iv 不由服务端
 * 下发，而是客户端用 salt + 两份**硬编码密钥材料**现场派生（所以每包 key/iv 都不同）：
 *
 *   raw  = QQTEA_decrypt(ENC48, TEA16)     // 48 字节：交织链式 CBC + 16 轮大端 TEA
 *   core = raw[ (raw[0] & 7) + 3 : 48 - 7 ] // 去掉头 pad/2 字节 salt 与尾部 7 字节
 *   key  = MD5(core_key + salt)             // 16 字节
 *   iv   = MD5(core_iv  + salt)             // 16 字节
 *
 * 收发的密文体是 `{ field1: salt, field2: AES-128-CBC/PKCS#7 }`（见 `./schemas`），
 * 明文是 protobuf。
 *
 * 四份材料在 Windows 与 Linux 的 `wrapper.node` 里逐字节一致（Windows 侧是 `.rdata`
 * 里连续 128 字节的一块），所以这套派生跨版本 / 跨平台通用。
 *
 * 黄金样本见 `test/redbag.test.ts`：用抓包的 salt 重算 key/iv 并重新加密，能**逐字节**
 * 复现抓包里那 128 字节密文。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * `GenerateAesKey` 的两份材料：48 字节待解密的密钥材料 + 16 字节 QQTEA 密钥。
 *
 * 二进制里紧挨着排布（Windows `0x1843D261C` 起，Linux 拆在 `0xD8CF56` / `0xBBD880`）。
 */
export const RED_BAG_KEY_MATERIAL = {
  enc: '97cb498fd669f73e404d29326b99fcbd1f4d54d514b171456a530b88af8c079d620f01e975acd7f262d08c09ed802c66',
  tea: '1014c03701d619b5360c12884359493b',
} as const;

/** `GenerateAesIV` 的两份材料（Windows 紧跟在 KEY 材料之后，Linux `0xD8CF86` / `0xBBF6B0`）。 */
export const RED_BAG_IV_MATERIAL = {
  enc: '0cdfec6f71cd40464c004939ef67ded4857e547b8eb9994145627b680f9ccc02f5b1264a3906af59b83d5c7aadd88da4',
  tea: 'eb5a3e190c7ceb0b047a7624a713179f',
} as const;

/** 单包 salt 固定 16 字节。 */
export const RED_BAG_SALT_LENGTH = 16;

const TEA_DELTA = 0x9e3779b9;
const TEA_ROUNDS = 16;
/** TEA 解码后的尾部丢弃长度（`oi_symmetry_decrypt2` 的固定尾巴）。 */
const TEA_TAIL = 7;

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function beU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

function putBeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

/** 单块 TEA 解密（大端、16 轮，密钥表 4×u32）。 */
function teaDecryptBlock(v0: number, v1: number, k: Uint32Array): [number, number] {
  let s = (TEA_DELTA * TEA_ROUNDS) >>> 0;
  for (let i = 0; i < TEA_ROUNDS; i++) {
    v1 = (v1 - ((((v0 << 4) + k[2]!) ^ (v0 + s) ^ ((v0 >>> 5) + k[3]!)) >>> 0)) >>> 0;
    v0 = (v0 - ((((v1 << 4) + k[0]!) ^ (v1 + s) ^ ((v1 >>> 5) + k[1]!)) >>> 0)) >>> 0;
    s = (s - TEA_DELTA) >>> 0;
  }
  return [v0, v1];
}

/**
 * 腾讯交织链式 CBC 的 QQTEA 解密（全量，不做头尾裁剪）。
 *
 * 与 `@weq/service` 里 emoji 用的 `qqteaDecrypt` 是同一个算法，只是那个函数自带
 * 「跳过头部 + 截到 GIF trailer `0x3b`」的封装，这里需要原始 48 字节。
 */
function qqteaDecrypt(ciphertext: Uint8Array, key: Uint8Array): Uint8Array {
  if (key.length !== 16) throw new Error(`QQTEA 密钥必须是 16 字节，收到 ${key.length}`);
  if (ciphertext.length === 0 || ciphertext.length % 8 !== 0) {
    throw new Error(`QQTEA 密文长度必须是 8 的倍数，收到 ${ciphertext.length}`);
  }

  const k = new Uint32Array(4);
  for (let i = 0; i < 4; i++) k[i] = beU32(key, i * 4);

  const out = new Uint8Array(ciphertext.length);
  let plainPrev0 = 0;
  let plainPrev1 = 0;
  let cipherPrev0 = 0;
  let cipherPrev1 = 0;
  for (let offset = 0; offset < ciphertext.length; offset += 8) {
    const c0 = beU32(ciphertext, offset);
    const c1 = beU32(ciphertext, offset + 4);
    const [d0, d1] = teaDecryptBlock((c0 ^ plainPrev0) >>> 0, (c1 ^ plainPrev1) >>> 0, k);
    putBeU32(out, offset, (d0 ^ cipherPrev0) >>> 0);
    putBeU32(out, offset + 4, (d1 ^ cipherPrev1) >>> 0);
    plainPrev0 = d0;
    plainPrev1 = d1;
    cipherPrev0 = c0;
    cipherPrev1 = c1;
  }
  return out;
}

/** 从一份密钥材料 + 本包 salt 派生出 16 字节 AES 密钥（key 与 iv 各调一次）。 */
function deriveSecret(material: { enc: string; tea: string }, salt: Uint8Array): Uint8Array {
  if (salt.length !== RED_BAG_SALT_LENGTH) {
    throw new Error(`红包 salt 必须是 ${RED_BAG_SALT_LENGTH} 字节，收到 ${salt.length}`);
  }
  const raw = qqteaDecrypt(hexToBytes(material.enc), hexToBytes(material.tea));
  const padding = raw[0]! & 0x07;
  const core = raw.subarray(padding + 3, raw.length - TEA_TAIL);
  return new Uint8Array(createHash('md5').update(core).update(salt).digest());
}

/** 本包 salt → AES-128 key（16 字节）。 */
export function deriveRedBagKey(salt: Uint8Array): Uint8Array {
  return deriveSecret(RED_BAG_KEY_MATERIAL, salt);
}

/** 本包 salt → AES-128 iv（16 字节）。 */
export function deriveRedBagIv(salt: Uint8Array): Uint8Array {
  return deriveSecret(RED_BAG_IV_MATERIAL, salt);
}

/**
 * 加密一段红包明文（protobuf 字节），返回 `{ salt, body }`。
 *
 * `salt` 缺省现生成 16 字节随机值；显式传入可用于复现抓包样本（同 salt + 同明文
 * ⇒ 同密文，AES-CBC 是确定性的）。
 */
export function encryptRedBagPayload(
  plain: Uint8Array,
  salt: Uint8Array = new Uint8Array(randomBytes(RED_BAG_SALT_LENGTH)),
): { salt: Uint8Array; body: Uint8Array } {
  const cipher = createCipheriv('aes-128-cbc', deriveRedBagKey(salt), deriveRedBagIv(salt));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { salt, body: new Uint8Array(body) };
}

/** 解密一段红包密文，剥掉 PKCS#7 填充后返回明文 protobuf 字节。 */
export function decryptRedBagPayload(salt: Uint8Array, body: Uint8Array): Uint8Array {
  const decipher = createDecipheriv('aes-128-cbc', deriveRedBagKey(salt), deriveRedBagIv(salt));
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return new Uint8Array(plain);
}
