/**
 * SendTuwenArk (0xdc2_34) 的离线单元测试:请求编码(黄金字节)+ 空响应解析。
 *
 * 黄金字节按 0xdc2_34 的 RE 字段布局(见 src/oidb/send-tuwen-ark.ts)由 wire
 * format 手工构建,与 SnowLuma 的 byte-oracle 断言一致:
 *   - appInfo 字段顺序 1,2,3,5,11,12;meta 字段顺序 1,2
 *   - peerType=0(C2C)/field3=0/空 previewUrl 也要上 wire(pb_optional → force)
 * 联网的端到端发送在 `tools/send_tuwen_ark.ts`。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { SendTuwenArk } from '../src/index';
import type { SendTuwenArkParams } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

const DEFAULT_PREVIEW_URL =
  'https://tangram-1251316161.file.myqcloud.com/files/20210721/e50a8e37e08f29bf1ffc7466e1950690.png';

/** C2C: targetId=2863253201, peerType=0 —— peerType/field3 的 0 值在 wire 上。 */
const GOLDEN_C2C = hexToBytes(`
  0a cf 02 08 a2 e0 f2 2f 10 01 18 00 2a 02 08 01 58 d1 8d a7 d5 0a 62 b9 02
  08 01 52 0e 51 51 e5 bc 80 e6 94 be e5 b9 b3 e5 8f b0 5a 95 01
  51 51 e5 b0 8f e7 a8 8b e5 ba 8f e6 98 af e8 bf 9e e6 8e a5 e5 b9 bf e8 bd
  bb e7 94 a8 e6 88 b7 e7 9a 84 e6 96 b0 e6 96 b9 e5 bc 8f ef bc 8c e8 a6 86
  e7 9b 96 38 e4 ba bf e6 96 b0 e7 94 9f e4 bb a3 e6 b4 bb e8 b7 83 e7 bd 91
  e6 b0 91 e3 80 82 e8 bd bb e4 be bf e5 bf ab e6 8d b7 e7 9a 84 e5 bc 80 e5
  8f 91 e6 a8 a1 e5 bc 8f ef bc 8c e5 b0 86 e8 83 bd e5 9c a8 51 51 e5 86 85
  e8 a2 ab e8 bd bb e6 9d be e8 8e b7 e5 8f 96 e5 92 8c e4 bc a0 e6 92 ad
  62 17 5b e5 88 86 e4 ba ab 5d 20 51 51 e5 bc 80 e6 94 be e5 b9 b3 e5 8f b0
  6a 12 68 74 74 70 73 3a 2f 2f 71 2e 71 71 2e 63 6f 6d 2f 72 72 60
  68 74 74 70 73 3a 2f 2f 74 61 6e 67 72 61 6d 2d 31 32 35 31 33 31 36 31 36
  31 2e 66 69 6c 65 2e 6d 79 71 63 6c 6f 75 64 2e 63 6f 6d 2f 66 69 6c 65 73
  2f 32 30 32 31 30 37 32 31 2f 65 35 30 61 38 65 33 37 65 30 38 66 32 39 62
  66 31 66 66 63 37 34 36 36 65 31 39 35 30 36 39 30 2e 70 6e 67
  12 08 08 00 10 d1 8d a7 d5 0a
`);

/** 群聊: targetId=123456789, peerType=1 —— 空 previewUrl 也在 wire 上。 */
const GOLDEN_GROUP = hexToBytes(`
  0a 5c 08 a2 e0 f2 2f 10 01 18 00 2a 02 08 01 58 95 9a ef 3a 62 48 08 01
  52 0c e6 b5 8b e8 af 95 e6 a0 87 e9 a2 98 5a 0c e6 b5 8b e8 af 95 e6 8f 8f
  e8 bf b0 62 0c e6 b5 8b e8 af 95 e6 91 98 e8 a6 81 6a 18
  68 74 74 70 73 3a 2f 2f 65 78 61 6d 70 6c 65 2e 63 6f 6d 2f 6a 75 6d 70
  72 00 12 07 08 01 10 95 9a ef 3a
`);

const C2C_PARAMS: SendTuwenArkParams = {
  targetId: 2863253201,
  peerType: 0,
  title: 'QQ开放平台',
  desc: 'QQ小程序是连接广轻用户的新方式，覆盖8亿新生代活跃网民。轻便快捷的开发模式，将能在QQ内被轻松获取和传播',
  summary: '[分享] QQ开放平台',
  jumpUrl: 'https://q.qq.com/r',
  previewUrl: DEFAULT_PREVIEW_URL,
};

const GROUP_PARAMS: SendTuwenArkParams = {
  targetId: 123456789,
  peerType: 1,
  title: '测试标题',
  desc: '测试描述',
  summary: '测试摘要',
  jumpUrl: 'https://example.com/jump',
  previewUrl: '',
};

describe('SendTuwenArk (0xdc2_34)', () => {
  it('declares command 0xdc2 sub 34 (SSO: OidbSvcTrpcTcp.0xdc2_34)', () => {
    expect(SendTuwenArk.command).toBe(0xdc2);
    expect(SendTuwenArk.subCommand).toBe(34);
  });

  it('encodes the C2C request exactly like the RE layout (peerType=0 on wire)', () => {
    const bytes = encode(SendTuwenArk.reqSchema, SendTuwenArk.serialize(C2C_PARAMS));
    expect(bytes).toEqual(GOLDEN_C2C);
  });

  it('encodes the group request exactly like the RE layout (empty previewUrl on wire)', () => {
    const bytes = encode(SendTuwenArk.reqSchema, SendTuwenArk.serialize(GROUP_PARAMS));
    expect(bytes).toEqual(GOLDEN_GROUP);
  });

  it('decodes ack response to void (deserialize returns undefined)', () => {
    const body = decode(SendTuwenArk.respSchema, new Uint8Array(0));
    expect(SendTuwenArk.deserialize(body)).toBeUndefined();
  });

  it('round-trips serialize → decode', () => {
    const bytes = encode(SendTuwenArk.reqSchema, SendTuwenArk.serialize(GROUP_PARAMS));
    const body = decode(SendTuwenArk.reqSchema, bytes);
    expect(body).toEqual({
      appInfo: {
        appId: 100446242,
        field2: 1,
        field3: 0,
        field5: { field1: 1 },
        targetId: 123456789,
        content: {
          flag: 1,
          title: '测试标题',
          desc: '测试描述',
          summary: '测试摘要',
          jumpUrl: 'https://example.com/jump',
          previewUrl: '',
        },
      },
      meta: { peerType: 1, targetId: 123456789 },
    });
  });
});
