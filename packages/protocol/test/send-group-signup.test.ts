/**
 * SendGroupSignup (OIDB 0x921b_0) 的离线单元测试。
 *
 * 1. 用**真机抓包**的 request 字节喂给 schema，逐字段核对（证明字段号/类型对得上）；
 * 2. 用最小参数编码，断言黄金字节（证明 force 字段与 f10 固定值都照抄）；
 * 3. 参数校验。
 *
 * 抓包来源（2026-10-03）：群号 673646675「图片收集」上传图片；含附带图片
 * f7 = { width:1125, height:660, url:vfiles…png, md5:df35… }。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode, type ProtoMessage } from '../src/protobuf';
import { SendGroupSignup } from '../src/index';
import type { SendGroupSignupParams } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');

/** 真机抓包：body.f1（request）的 425 字节。 */
const CAPTURED_REQUEST_HEX = `
  0A 00 10 D3 90 9C C1 02 1A 0C E5 9B BE E7 89 87 E6 94 B6 E9 9B 86
  22 D0 01 E6 94 B6 E6 AC BE E6 88 AA E5 9B BE 20 E5 B7 B2 E6 8B BC
  E5 9B A2 E5 90 8C E5 AD A6 E8 AF B7 E5 B0 BD E5 BF AB E4 B8 8A E4
  BC A0 E8 87 AA E5 B7 B1 E7 9A 84 E4 BA A4 E6 AC BE E4 BF A1 E6 81
  AF E6 88 AA E5 9B BE 0A F0 9F 8C 9F E4 BA A4 E6 AC BE E8 AF A6 E6
  83 85 0A E5 85 B7 E4 BD 93 E4 BA A4 E6 AC BE E5 90 8D E5 8D 95 E5
  92 8C E6 95 B0 E9 A2 9D E8 AF B7 E7 9C 8B E4 B8 8B E5 9B BE EF BC
  8C E8 AF B7 E5 A4 A7 E5 AE B6 E6 A0 B8 E5 AF B9 E5 9B BE E7 89 87
  E6 8C 89 E6 97 B6 E6 8F 90 E4 BA A4 E6 AD A3 E7 A1 AE E6 95 B0 E9
  A2 9D 0A F0 9F 95 90 E6 88 AA E6 AD A2 E6 97 B6 E9 97 B4 0A 32 30
  32 34 2F 39 2F 32 30 20 32 34 3A 30 30 28 00 30 80 CD 84 D6 06 3A
  9B 01 08 E5 08 10 94 05 1A 71 68 74 74 70 73 3A 2F 2F 76 66 69 6C
  65 73 2E 67 74 69 6D 67 2E 63 6E 2F 77 75 70 6C 6F 61 64 2F 53 74
  72 61 74 65 67 79 43 65 6E 74 65 72 54 65 73 74 2E 74 65 61 6D 5F
  75 70 5F 74 65 6D 70 6C 61 74 65 2F 36 34 37 61 38 31 37 30 5F 54
  65 44 31 35 31 6A 53 66 76 65 57 62 35 65 4F 41 77 46 39 51 69 64
  4C 72 33 62 58 48 2D 37 46 2E 70 6E 67 22 20 64 66 33 35 64 39 39
  31 30 64 65 38 64 30 32 31 35 34 31 62 39 63 31 36 31 63 64 63 64
  66 33 30 40 01 48 02 50 C8 01 58 00 60 00 6A 06 08 00 12 00 1A 00 70
  00 78 00 80 01 00
`;

/** body.f1 的 schema（真机抓包里 request 那一层）。 */
const REQUEST_SCHEMA = SendGroupSignup.reqSchema.fields[0]!.type as ProtoMessage;

interface DecodedRequest {
  groupCode: bigint;
  title: string;
  detail: string;
  field5: number;
  deadline: number;
  image: { width: number; height: number; url: string; md5: string };
  maxCount: number;
  signupMethod: number;
  field10: number;
  field11: number;
  field12: number;
  extra: { field1: number; field2: string; field3: string };
  field14: number;
  field15: number;
  field16: number;
}

describe('SendGroupSignup (0x921b_0)', () => {
  it('声明 command 0x921b / subCommand 0', () => {
    expect(SendGroupSignup.command).toBe(0x921b);
    expect(SendGroupSignup.subCommand).toBe(0);
  });

  it('能逐字段解出真机抓包的 request', () => {
    const decoded = decode(
      REQUEST_SCHEMA,
      hexToBytes(CAPTURED_REQUEST_HEX),
    ) as unknown as DecodedRequest;
    expect(decoded.groupCode).toBe(673646675n);
    expect(decoded.title).toBe('图片收集');
    expect(String(decoded.detail).startsWith('收款截图')).toBe(true);
    expect(String(decoded.detail).includes('截止时间')).toBe(true);
    expect(decoded.field5).toBe(0);
    expect(decoded.deadline).toBe(1791043200);
    expect(decoded.image).toEqual({
      width: 1125,
      height: 660,
      url: 'https://vfiles.gtimg.cn/wupload/StrategyCenterTest.team_up_template/647a8170_TeD151jSfveWb5eOAwF9QidLr3bXH-7F.png',
      md5: 'df35d9910de8d021541b9c161cdcdf30',
    });
    expect(decoded.maxCount).toBe(1);
    expect(decoded.signupMethod).toBe(2);
    expect(decoded.field10).toBe(200);
    expect(decoded.field11).toBe(0);
    expect(decoded.field12).toBe(0);
    expect(decoded.extra).toEqual({ field1: 0, field2: '', field3: '' });
    expect(decoded.field14).toBe(0);
    expect(decoded.field15).toBe(0);
    expect(decoded.field16).toBe(0);
  });

  it('抓包 request 解码后再编码，逐字节还原（force 字段 / 字段顺序一致）', () => {
    const bytes = hexToBytes(CAPTURED_REQUEST_HEX);
    const decoded = decode(REQUEST_SCHEMA, bytes);
    expect(bytesToHex(encode(REQUEST_SCHEMA, decoded))).toBe(bytesToHex(bytes));
  });

  it('最小参数编码出黄金字节（f10 固定 200，method 默认 1，maxCount 默认 200）', () => {
    const params: SendGroupSignupParams = { groupCode: 123, title: 't', detail: 'd' };
    const bytes = encode(SendGroupSignup.reqSchema, SendGroupSignup.serialize(params));
    expect(bytesToHex(bytes)).toBe(
      bytesToHex(
        hexToBytes(`
          0A 27 0A 00 10 7B 1A 01 74 22 01 64 28 00
          40 C8 01 48 01 50 C8 01 58 00 60 00
          6A 06 08 00 12 00 1A 00 70 00 78 00 80 01 00 60 01
        `),
      ),
    );
  });

  it('body 外层带 f12=1、request 在 f1', () => {
    const body = SendGroupSignup.serialize({ groupCode: 1, title: 't', detail: 'd' });
    expect(body.field12).toBe(1);
    expect((body.request as Record<string, unknown>).groupCode).toBe(1);
  });

  it('deadline 缺席 = 不截止；给了就上 f6', () => {
    const withOut = encode(
      SendGroupSignup.reqSchema,
      SendGroupSignup.serialize({ groupCode: 1, title: 't', detail: 'd' }),
    );
    const withDeadline = encode(
      SendGroupSignup.reqSchema,
      SendGroupSignup.serialize({ groupCode: 1, title: 't', detail: 'd', deadline: 1791043200 }),
    );
    expect(withDeadline.length).toBeGreaterThan(withOut.length);
    const decoded = decode(SendGroupSignup.reqSchema, withDeadline) as {
      request: Record<string, unknown>;
    };
    expect(decoded.request.deadline).toBe(1791043200);
  });

  it('参数非法时在编码前报错', () => {
    expect(() => SendGroupSignup.serialize({ groupCode: 0, title: 't', detail: 'd' })).toThrow(
      /groupCode/,
    );
    expect(() => SendGroupSignup.serialize({ groupCode: 1, title: '', detail: 'd' })).toThrow(
      /title/,
    );
    expect(() => SendGroupSignup.serialize({ groupCode: 1, title: 't', detail: '' })).toThrow(
      /detail/,
    );
    expect(() =>
      SendGroupSignup.serialize({ groupCode: 1, title: 't', detail: 'd', maxCount: 0 }),
    ).toThrow(/maxCount/);
  });

  it('invoke 走 0x921b / sub 0 / 非 uid 表单', async () => {
    const calls: Array<{ command: number; subCommand: number; isUid: boolean }> = [];
    const nt = {
      sendOidbPacket: async (
        _pid: number,
        command: number,
        subCommand: number,
        _body: Buffer,
        isUid: boolean,
      ): Promise<Buffer> => {
        calls.push({ command, subCommand, isUid });
        return Buffer.alloc(0);
      },
    };
    await SendGroupSignup.invoke(nt, 7, { groupCode: 123, title: 't', detail: 'd' });
    expect(calls).toEqual([{ command: 0x921b, subCommand: 0, isUid: false }]);
  });
});
