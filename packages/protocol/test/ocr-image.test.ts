/**
 * OcrImage (0xe07_0) 的离线单元测试 —— 全部基于 2026-10-16 的抓包向量：
 *   • 上行：参数 → inner body 字节，逐字节复现抓包（`OCR_REQ_INNER_HEX`）；
 *   • 下行：服务端原始回包 → 文本 + 文字框（`OCR_RESP_INNER_HEX`）。
 * 信封由 native 的 `sendOidbPacket` 补，所以 invoke 用例只 mock 该原语。
 */

import { describe, expect, it } from 'vitest';
import { OcrImage, quadToRect, rectToQuad, scaleOcrRect } from '../src/index';
import { bytesToHex } from '../src/oidb/shared';
import { encode } from '../src/protobuf';
import * as V from './ocr-image.vectors';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(hex.replace(/\s+/g, '').match(/../g) ?? [], (h) => Number.parseInt(h, 16));

const PARAMS = {
  url: V.OCR_REQUEST_URL,
  fileMd5: V.OCR_REQUEST_MD5,
  fileSize: V.OCR_REQUEST_FILE_SIZE,
  width: V.OCR_REQUEST_SIZE.width,
  height: V.OCR_REQUEST_SIZE.height,
};

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
  needSign: boolean;
}

function makeNative(reply: Uint8Array) {
  const calls: OidbCall[] = [];
  return {
    calls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
      needSign: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, command, subCommand, body: new Uint8Array(body), isUid, needSign });
      return Buffer.from(reply);
    },
  };
}

describe('OcrImage (0xe07_0) —— 上行', () => {
  it('命令字 / 子命令 / 免签名', () => {
    expect(OcrImage.command).toBe(0xe07);
    expect(OcrImage.subCommand).toBe(0);
    expect(OcrImage.needSign).toBe(false);
  });

  it('serialize：1 = 任务类型 1，2/3/15 恒 0，md5 同一值塞 10 与 11', () => {
    const body = OcrImage.serialize(PARAMS);
    expect(body.taskType).toBe(1);
    expect(body.field2).toBe(0);
    expect(body.field3).toBe(0);
    const image = body.image as Record<string, unknown>;
    expect(image.url).toBe(V.OCR_REQUEST_URL);
    expect(image.fileMd5).toBe(V.OCR_REQUEST_MD5);
    expect(image.fileMd5Dup).toBe(V.OCR_REQUEST_MD5);
    expect(image.fileSize).toBe(V.OCR_REQUEST_FILE_SIZE);
    expect(image.width).toBe(V.OCR_REQUEST_SIZE.width);
    expect(image.height).toBe(V.OCR_REQUEST_SIZE.height);
    expect(image.field15).toBe(0);
  });

  it('请求字节逐字节等于抓包（黄金向量）', () => {
    expect(bytesToHex(OcrImage.encodeRequest(PARAMS))).toBe(V.OCR_REQ_INNER_HEX);
  });

  it('md5 大小写都收，上行统一成小写', () => {
    const upper = OcrImage.encodeRequest({
      ...PARAMS,
      fileMd5: V.OCR_REQUEST_MD5.toUpperCase(),
    });
    expect(bytesToHex(upper)).toBe(V.OCR_REQ_INNER_HEX);
  });

  it('md5 不是 32 位 hex 时直接报错（不发出半包）', () => {
    expect(() => OcrImage.encodeRequest({ ...PARAMS, fileMd5: 'deadbeef' })).toThrow(/md5/);
    expect(() => OcrImage.encodeRequest({ ...PARAMS, url: '' })).toThrow(/图片地址/);
  });
});

describe('OcrImage (0xe07_0) —— 下行', () => {
  const result = OcrImage.decodeResponse(hexToBytes(V.OCR_RESP_INNER_HEX));

  it('状态与图片尺寸（回显上行 1127×1393）', () => {
    expect(result.status).toBe('succ');
    expect(result.imageWidth).toBe(V.OCR_REQUEST_SIZE.width);
    expect(result.imageHeight).toBe(V.OCR_REQUEST_SIZE.height);
  });

  it('逐段文本 + 文字框：5 是外接矩形，3.1 是同一个框的 4 个角点', () => {
    expect(result.blocks).toHaveLength(V.OCR_EXPECTED_BLOCKS.length);
    result.blocks.forEach((block, i) => {
      const want = V.OCR_EXPECTED_BLOCKS[i]!;
      expect(block.text).toBe(want.text);
      expect(block.parag).toBe(want.parag);
      expect(block.rect).toEqual(want.rect);
      expect(block.quad).toEqual(want.quad);
      // 两个字段本来就同源：角点回推出的外接矩形必须与 5 完全一致
      expect(quadToRect(block.quad)).toEqual(block.rect);
      expect(rectToQuad(block.rect)).toEqual(block.quad);
    });
  });

  it('语种信息', () => {
    expect(result.srcLang).toBe('en');
    expect(result.langs).toEqual(['zh', 'en', 'jp', 'kr']);
    expect(result.defaultLang).toBe('zh');
    expect(result.langNames).toHaveLength(8);
    expect(result.langNames[0]).toEqual({ code: 'kr', name: '韩语' });
    expect(result.langNames.at(-1)).toEqual({ code: 'jp', name: '日语' });
    expect(result.sessionId).toBe(V.OCR_RESP_SESSION_ID);
  });

  it('空回包 / 只给矩形时都能解出结果', () => {
    const empty = OcrImage.decodeResponse(new Uint8Array(0));
    expect(empty.status).toBe('');
    expect(empty.blocks).toEqual([]);

    // 造一个只有 10.1[].5（没有 3.1）的回包：quad 应由矩形补齐
    const onlyBbox = encode(OcrImage.respSchema, {
      status: 'succ',
      result: { blocks: [{ text: 'hi', bbox: { x: 10, y: 20, width: 30, height: 8 } }] },
    });
    const block = OcrImage.decodeResponse(onlyBbox).blocks[0]!;
    expect(block.rect).toEqual({ x: 10, y: 20, width: 30, height: 8 });
    expect(block.quad).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 28 },
      { x: 10, y: 28 },
    ]);
  });
});

describe('OcrImage (0xe07_0) —— invoke', () => {
  it('走 sendOidbPacket：0xe07_0、非 UIN-form、不签名', async () => {
    const nt = makeNative(hexToBytes(V.OCR_RESP_INNER_HEX));
    const result = await OcrImage.invoke(nt, 4242, PARAMS);

    expect(nt.calls).toHaveLength(1);
    const call = nt.calls[0]!;
    expect(call.pid).toBe(4242);
    expect(call.command).toBe(0xe07);
    expect(call.subCommand).toBe(0);
    expect(call.isUid).toBe(false);
    expect(call.needSign).toBe(false);
    expect(bytesToHex(call.body)).toBe(V.OCR_REQ_INNER_HEX);
    expect(result.blocks.map((b) => b.text)).toEqual(['WeQ', ':975790306']);
  });
});

describe('坐标工具', () => {
  it('scaleOcrRect 把「小图坐标」映射回目标尺寸', () => {
    // 原图 1127×1393 缩到一半送去 OCR，回包坐标 ×2 即回到原图
    expect(scaleOcrRect({ x: 180, y: 65, width: 66, height: 27 }, 2, 2)).toEqual({
      x: 360,
      y: 130,
      width: 132,
      height: 54,
    });
  });
});
