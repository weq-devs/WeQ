/**
 * 闪传 sliceupload 请求体（HTTP 直传）黄金字节测试。
 *
 * 字节布局来自真实 NapCat（QQ 内核）缩略图上传的**明文抓包**（wrapper.node 内
 * BoringSSL SSL_write 层捕获，2026-10 调试）。实机 top-level / payload 结构：
 *
 *   f1  = 0
 *   f2  = 14903                    （appid: png 缩略图）
 *   f3  = <n>                      （进程内单调递增的请求序号，不是常量！）
 *   f107 {
 *     f1   = {}                    （空 message）
 *     f2   = <rkey>
 *     f3   = 0                     （start）
 *     f4   = fileSize-1            （end）
 *     f5   = <sha1, 20B>
 *     f6   = { f1: <sha1, 20B> }   （sha1StateV）
 *     f7   = <chunk>
 *     f100 = 5
 *     f101 = <0x12a9_103 apply 响应里 filesetWrap 的**原始字节**，原样回带>
 *   }
 *
 * 三个关键结论（都靠逐字节比对确立，别再凭猜改回）:
 *   1. f101 必须原样回带 apply 响应 `payload.fs1`；服务端会规范化（缩略图补
 *      f5/f7 并去掉 f9，主文件补 f8/f9 并去掉 f5/f6），自造会被判未知文件。
 *   2. f3 是 **进程内单调递增计数器**（实机连续任务取 1,2,3,...）。
 *   3. f100 恒为 5。
 */

import { describe, expect, it } from 'vitest';
import { buildSliceBody, FLASH_SLICE_UPLOAD_BODY, decode } from '../src/index';

function bytes(...vals: number[]): Uint8Array {
  return Uint8Array.from(vals);
}

/** 一次实机缩略图上传的 rkey（327B，形如 CAES...）。 */
const RKEY =
  'CAES8AGW0mgCT1CUiiwUFvQYb13fGECQRNMLyn-jan-wHtDNMgfEdMnbT0iFXwcNs9R1RMdebRsdmpXE1BoqDw4-NWpY4FIEC9nHXfjABIij3VnL2p5HBI8P--bMGGfNP9wtd38G45onq-gcGmlfUC4dFRgCTt_7tRrxVMv9ZDT0Kvz1gqto1hVY8GTkelOO-UeeB8fpn-YfN7kkvBhbUqN5gTEr-sKGEHQy_0Z31ncBambeTSB_uxcX37DNzBAz1hyjMI-yDRa_tvrPi0jH6FDOVciaEKeTCzPWtAkhq8HU7X54UTQhIFhjI5iV78YTijnDQDw';

const SHA1 = bytes(
  0x3a,
  0x5e,
  0x95,
  0x4f,
  0xa3,
  0x1e,
  0x92,
  0xfe,
  0x5c,
  0x5b,
  0x07,
  0x26,
  0xf9,
  0x5c,
  0x1f,
  0x27,
  0x63,
  0xe5,
  0x66,
  0x70,
);

/** 实机 apply 响应里规范化后的缩略图 filesetWrap（120B，逐字节来自抓包）。 */
const THUMB_FILESET_REF = Uint8Array.from(
  Buffer.from(
    '0a2463616565613836662d356564372d343031652d613136342d663932316535336663383064' +
      '122463616565613836662d356564372d343031652d613136342d663932316535336663383064' +
      '1a2432373833373430662d643233372d353236322d613663382d363163393334343437656437' +
      '20022801381a',
    'hex',
  ),
);

function varint(v: number): number[] {
  const out: number[] = [];
  let n = v;
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
}
const tag = (f: number, w: number): number[] => varint((f << 3) | w);
const lenDelim = (f: number, body: Uint8Array): number[] => [
  ...tag(f, 2),
  ...varint(body.length),
  ...body,
];
const str = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

/** 手写 wire 编码，独立于被测算子。 */
function oracleBody(start: number, end: number, field3: number): Uint8Array {
  const sha1StateV = Uint8Array.from(lenDelim(1, SHA1));
  const payload = Uint8Array.from([
    ...lenDelim(1, new Uint8Array(0)),
    ...lenDelim(2, str(RKEY)),
    ...tag(3, 0),
    ...varint(start),
    ...tag(4, 0),
    ...varint(end),
    ...lenDelim(5, SHA1),
    ...lenDelim(6, sha1StateV),
    ...lenDelim(7, SHA1),
    ...tag(100, 0),
    ...varint(5),
    ...lenDelim(101, THUMB_FILESET_REF),
  ]);
  return Uint8Array.from([
    ...tag(1, 0),
    ...varint(0),
    ...tag(2, 0),
    ...varint(14903),
    ...tag(3, 0),
    ...varint(field3),
    ...lenDelim(107, payload),
  ]);
}

describe('buildSliceBody', () => {
  it('产出与实机抓包同构的 body（f100=5 + f101 原样 fileRef）', () => {
    const out = buildSliceBody(
      { rkey: RKEY, start: 0, end: SHA1.length - 1, sha1: SHA1, sha1StateV: [SHA1], chunk: SHA1 },
      { appid: 14903, field3: 1, field100: 5, fileRef: THUMB_FILESET_REF },
    );
    expect(Buffer.from(out).toString('hex')).toBe(
      Buffer.from(oracleBody(0, SHA1.length - 1, 1)).toString('hex'),
    );
  });

  it('f101 是传入的 fileRef 原始字节，不重新编码', () => {
    const out = buildSliceBody(
      { rkey: RKEY, start: 0, end: 0, sha1: SHA1, sha1StateV: [SHA1], chunk: SHA1 },
      { appid: 14903, field3: 1, field100: 5, fileRef: THUMB_FILESET_REF },
    );
    const hex = Buffer.from(out).toString('hex');
    expect(
      hex.includes(
        THUMB_FILESET_REF.length.toString(16).padStart(2, '0') +
          Buffer.from(THUMB_FILESET_REF).toString('hex'),
      ),
    ).toBe(true);
  });

  it('顶层 f3 跟随传入的请求序号', () => {
    for (const seq of [1, 7, 100]) {
      const out = buildSliceBody(
        { rkey: RKEY, start: 0, end: 0, sha1: SHA1, sha1StateV: [SHA1], chunk: SHA1 },
        { appid: 14903, field3: seq, field100: 5, fileRef: THUMB_FILESET_REF },
      );
      expect(decode(FLASH_SLICE_UPLOAD_BODY, out).field3).toBe(seq);
    }
  });

  it('payload 里 f100=5 且 f101 存在', () => {
    const out = buildSliceBody(
      { rkey: RKEY, start: 0, end: 0, sha1: SHA1, sha1StateV: [SHA1], chunk: SHA1 },
      { appid: 14903, field3: 1, field100: 5, fileRef: THUMB_FILESET_REF },
    );
    const hex = Buffer.from(out).toString('hex');
    expect(hex.includes('a00605')).toBe(true); // f100=5
    expect(hex.includes('aa0678')).toBe(true); // f101, len 120
  });

  it('未传 fileRef 时不上 wire（向后兼容）', () => {
    const out = buildSliceBody(
      { rkey: RKEY, start: 0, end: 0, sha1: SHA1, sha1StateV: [SHA1], chunk: SHA1 },
      { appid: 14901 },
    );
    expect(Buffer.from(out).toString('hex').includes('aa06')).toBe(false);
  });
});
