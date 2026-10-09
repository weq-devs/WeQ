/**
 * 闪传 0x12a9_100 prepare-upload 的**角色字段**单测。
 *
 * 黄金取值来自 2026-10-10 真机（PC QQ 内核 wrapper.node）闪传抓包：同一次任务里
 * 主文件与封面（PNG 缩略图）各发一条 prepare，两者唯一的 role 差异是 payload.f2：
 *
 *   payload.f2 = 1  → 这一条是**封面缩略图**
 *   payload.f2 = 0  → 这一条是主文件
 *
 * 旧实现写反（主文件 1、缩略图 0）。写反会让服务端不把该上传登记为 fileset 封面，
 * 卡片就回退默认封面（封面不显示）。别再凭旧注释改回去。
 *
 * 同抓包钉死的其它封面字段：FileInfo.f6/f7 = 宽高（供预览）、filesetWrap.f4 = 文件
 * 序号、f5 = 1（封面标记）、f7 = 26（PNG 图片类型码）、f9 = 0。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/index';
import { PrepareUpload } from '../src/oidb/flashtransfer/prepare-upload';

const FILESET = 'b3f55608-f8ca-4957-88e7-b0e6be9de8f8';
const MAIN_UUID = '7181f600-b934-9e37-d2e1-9748dad037ae';
const COVER_UUID = 'ef0e90bc-59f0-0963-99a8-95df639eb0b0';

/** 主文件：2429B 未知类型（formatCode 11），无封面字段。 */
const MAIN = {
  filesetUuid: FILESET,
  fileUuid: MAIN_UUID,
  fileName: 'passwd',
  fileSize: 2429,
  sha1: 'db6cf8717e2224ad63fd1241235518d715888610',
  fileIndex: 1,
  formatCode: 11,
} as const;

/** 封面：dd.png 12968B，600×600。 */
const COVER = {
  filesetUuid: FILESET,
  fileUuid: COVER_UUID,
  fileName: 'dd.png',
  fileSize: 12968,
  sha1: '37fb5a9c0791d3c276f28a108bf5e1a28dff93bf',
  fileIndex: 2,
  formatCode: 26,
  thumbType: 'png',
  width: 600,
  height: 600,
} as const;

interface PayloadView {
  field2: number;
  wrapper: { fileInfo: Record<string, number> };
  filesetWrap: Record<string, unknown>;
}

function payloadOf(p: typeof MAIN | typeof COVER): PayloadView {
  const req = PrepareUpload.serialize(p as never) as { payload: PayloadView };
  return req.payload;
}

function decodedPayload(p: typeof MAIN | typeof COVER): PayloadView {
  const req = PrepareUpload.serialize(p as never) as never;
  const bytes = encode(PrepareUpload.reqSchema, req);
  return (decode(PrepareUpload.reqSchema, bytes) as { payload: PayloadView }).payload;
}

describe('prepare-upload 角色字段（0x12a9_100）', () => {
  it('主文件 payload.f2 = 0', () => {
    expect(payloadOf(MAIN).field2).toBe(0);
    expect(decodedPayload(MAIN).field2).toBe(0);
  });

  it('封面（png 缩略图）payload.f2 = 1', () => {
    expect(payloadOf(COVER).field2).toBe(1);
    expect(decodedPayload(COVER).field2).toBe(1);
  });

  it('jpg 缩略图同样是封面（payload.f2 = 1）', () => {
    expect(payloadOf({ ...COVER, thumbType: 'jpg' } as never).field2).toBe(1);
  });

  it('封面 filesetWrap 与抓包一致：序号 2、封面标记 1、类型码 26、无主文件标记', () => {
    const wrap = payloadOf(COVER).filesetWrap;
    expect(wrap.field4).toBe(2);
    expect(wrap.field5).toBe(1);
    expect(wrap.field7).toBe(26);
    expect(wrap.field9).toBe(0);
  });

  it('主文件 filesetWrap：序号 1、无封面标记、类型码 11、主文件标记 1', () => {
    const wrap = payloadOf(MAIN).filesetWrap;
    expect(wrap.field4).toBe(1);
    expect(wrap.field5).toBe(0);
    expect(wrap.field7).toBe(11);
    expect(wrap.field9).toBe(1);
  });

  it('封面 FileInfo 带真实宽高（抓包 600×600）', () => {
    const info = decodedPayload(COVER).wrapper.fileInfo;
    expect(info.field6).toBe(600);
    expect(info.field7).toBe(600);
    expect(info.field9).toBe(1);
  });
});
