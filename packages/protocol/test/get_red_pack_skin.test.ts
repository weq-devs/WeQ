/**
 * GetRedPackSkin — `trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo` 的离线单测。
 *
 * 覆盖三件事：请求编码的黄金字节（对着 2026-10-14 真机抓包）、trpc 路由（命令字 /
 * needSign），以及真实回包的字段解析。回包样本是 skin 2658（「生日祝福」）的 845 字节。
 *
 * 请求里的 f1（trace id）实测服务端不校验 —— 随机 v4 / 全零 / 非 UUID / 空串回包逐字节
 * 一致，所以实现里固定全零；黄金字节也就按全零写。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { GetRedPackSkin, RED_PACK_SKIN_TRACE_ID } from '../src/index';
import type { RedPackSkinResponse } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

const bytesToHex = (bytes: Uint8Array): string =>
  [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

interface TrpcCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
  needSign?: boolean;
}

function makeNative(resp: Uint8Array = new Uint8Array(0)) {
  const calls: TrpcCall[] = [];
  return {
    calls,
    sendPacket: async (
      pid: number,
      cmd: string,
      body: Buffer,
      needSign?: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, cmd, body: new Uint8Array(body), needSign });
      return Buffer.from(resp);
    },
  };
}

/** 真机回包：skin 2658「生日祝福」，845 字节。 */
const RESP_SKIN_2658 = hexToBytes(`
  0a 24 64 63 35 61 30 39 61 32 2d 61 34 64 34 2d 34 62 35 39 2d 61 33 64 63 2d 31 63 39 62 30 34 35 33 35 66 64 36
  22 a0 06 08 e2 14 10 01 1a 0c e7 94 9f e6 97 a5 e7 a5 9d e7 a6 8f
  22 7c 0a 18 e8 85 be e8 ae af e8 ae be e8 ae a1 e5 bc 80 e6 94 be e5 b9 b3 e5 8f b0
  12 60 68 74 74 70 73 3a 2f 2f 6d 6f 67 67 79 2d 69 6d 61 67 65 2d 31 32 35 31 33 31 36 31 36 31 2e 66 69 6c 65 2e 6d 79 71 63 6c 6f 75 64 2e 63 6f 6d 2f 69 6d 67 2f 32 30 32 36 30 32 2f 63 62 66 64 35 61 30 30 33 35 35 35 39 32 65 32 39 35 34 34 37 30 64 36 63 64 31 38 35 65 34 63 2e 70 6e 67
  2a 8e 01 0a 12 e9 a2 86 e5 8f 96 e5 90 8c e6 ac be e5 b0 81 e9 9d a2
  12 76 68 74 74 70 73 3a 2f 2f 69 2e 71 69 61 6e 62 61 6f 2e 71 71 2e 63 6f 6d 2f 77 61 6c 6c 65 74 2f 61 70 70 6c 79 52 65 64 70 61 63 6b 65 74 43 6f 76 65 72 2f 69 6e 64 65 78 2e 68 74 6d 6c 3f 5f 77 76 3d 33 33 35 35 34 34 33 32 26 73 6b 69 6e 5f 63 6f 64 65 3d 74 69 73 33 35 58 44 4e 34 71 68 41 31 54 57 62 65 6c 56 67 63 71 4f 66 6a 43 56 68 42 4f 49 41
  1a 00
  42 60 68 74 74 70 73 3a 2f 2f 6d 6f 67 67 79 2d 69 6d 61 67 65 2d 31 32 35 31 33 31 36 31 36 31 2e 66 69 6c 65 2e 6d 79 71 63 6c 6f 75 64 2e 63 6f 6d 2f 69 6d 67 2f 32 30 32 36 30 34 2f 66 35 66 36 39 33 35 38 63 61 36 36 66 32 30 36 33 37 39 39 36 61 64 36 32 37 34 30 61 38 37 39 2e 70 6e 67
  4a 60 68 74 74 70 73 3a 2f 2f 6d 6f 67 67 79 2d 69 6d 61 67 65 2d 31 32 35 31 33 31 36 31 36 31 2e 66 69 6c 65 2e 6d 79 71 63 6c 6f 75 64 2e 63 6f 6d 2f 69 6d 67 2f 32 30 32 36 30 34 2f 30 39 62 61 37 31 64 35 66 33 30 39 37 64 31 30 62 30 65 66 65 34 39 66 66 62 35 64 36 33 65 34 2e 70 6e 67
  52 60 68 74 74 70 73 3a 2f 2f 6d 6f 67 67 79 2d 69 6d 61 67 65 2d 31 32 35 31 33 31 36 31 36 31 2e 66 69 6c 65 2e 6d 79 71 63 6c 6f 75 64 2e 63 6f 6d 2f 69 6d 67 2f 32 30 32 36 30 34 2f 34 31 31 32 66 61 66 66 37 30 34 34 66 36 34 32 32 62 30 39 32 64 64 35 31 36 36 33 35 35 35 32 2e 70 6e 67
  5a 66 08 00 12 60 68 74 74 70 73 3a 2f 2f 6d 6f 67 67 79 2d 69 6d 61 67 65 2d 31 32 35 31 33 31 36 31 36 31 2e 66 69 6c 65 2e 6d 79 71 63 6c 6f 75 64 2e 63 6f 6d 2f 69 6d 67 2f 32 30 32 36 30 34 2f 37 36 36 64 34 37 34 63 64 35 38 66 65 39 39 30 61 38 36 34 32 38 36 36 35 32 34 37 65 37 35 64 2e 70 6e 67
  1a 00 68 00 70 00 8a 01 00 92 01 00 9a 01 00
  d2 01 60 68 74 74 70 73 3a 2f 2f 6d 6f 67 67 79 2d 69 6d 61 67 65 2d 31 32 35 31 33 31 36 31 36 31 2e 66 69 6c 65 2e 6d 79 71 63 6c 6f 75 64 2e 63 6f 6d 2f 69 6d 67 2f 32 30 32 36 30 34 2f 31 62 30 38 62 32 36 35 65 30 64 65 32 63 31 66 30 64 37 31 63 38 34 37 66 34 30 66 65 61 65 34 2e 70 6e 67
  28 c0 d1 02
`);

const MOGGY = 'https://moggy-image-1251316161.file.myqcloud.com';

describe('GetRedPackSkin (trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo)', () => {
  it('声明命令字并显式关掉签名', () => {
    expect(GetRedPackSkin.cmd).toBe('trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo');
    expect(GetRedPackSkin.needSign).toBe(false);
  });

  it('请求黄金字节：f1 全零 trace id + f3 skinId + f6=0（43 字节）', () => {
    const body = GetRedPackSkin.serialize({ skinId: 2658 });
    expect(body.traceId).toBe(RED_PACK_SKIN_TRACE_ID);
    const bytes = encode(GetRedPackSkin.reqSchema, body);
    const uuid = [...RED_PACK_SKIN_TRACE_ID].map((c) => c.charCodeAt(0).toString(16));
    expect(bytesToHex(bytes)).toBe(['0a 24', ...uuid, '18 e2 14', '30 00'].join(' '));
    expect(bytes.length).toBe(43);
    expect(decode(GetRedPackSkin.reqSchema, bytes)).toEqual({
      traceId: RED_PACK_SKIN_TRACE_ID,
      skinId: 2658,
      flag: 0,
    });
  });

  it('traceId 可覆盖（但服务端并不校验）', () => {
    const bytes = encode(
      GetRedPackSkin.reqSchema,
      GetRedPackSkin.serialize({ skinId: 1, traceId: 'dc5a09a2-a4d4-4b59-a3dc-1c9b04535fd6' }),
    );
    expect(decode(GetRedPackSkin.reqSchema, bytes).traceId).toBe(
      'dc5a09a2-a4d4-4b59-a3dc-1c9b04535fd6',
    );
  });

  it('发到命令字、不带签名', async () => {
    const nt = makeNative();
    await GetRedPackSkin.invoke(nt, 7, { skinId: 2658 });
    expect(nt.calls).toHaveLength(1);
    expect(nt.calls[0]).toMatchObject({
      pid: 7,
      cmd: 'trpc.qpay.red_pack_skin.Skin.SsoGetSkinInfo',
      needSign: false,
    });
  });

  it('解析真机回包：skin 2658「生日祝福」', async () => {
    const nt = makeNative(RESP_SKIN_2658);
    const resp = await GetRedPackSkin.invoke(nt, 7, { skinId: 2658 });
    expect(resp.traceId).toBe('dc5a09a2-a4d4-4b59-a3dc-1c9b04535fd6');
    expect(resp.ttl).toBe(43200);
    expect(resp.skin).toEqual({
      id: 2658,
      state: 1,
      name: '生日祝福',
      cover: {
        label: '腾讯设计开放平台',
        url: `${MOGGY}/img/202602/cbfd5a00355592e2954470d6cd185e4c.png`,
      },
      jump: {
        label: '领取同款封面',
        url: 'https://i.qianbao.qq.com/wallet/applyRedpacketCover/index.html?_wv=33554432&skin_code=tis35XDN4qhA1TWbelVgcqOfjCVhBOIA',
        extra: '',
      },
      image: `${MOGGY}/img/202604/f5f69358ca66f20637996ad62740a879.png`,
      preview: `${MOGGY}/img/202604/09ba71d5f3097d10b0efe49ffb5d63e4.png`,
      popup: `${MOGGY}/img/202604/4112faff7044f6422b092dd516635552.png`,
      background: {
        flag: 0,
        url: `${MOGGY}/img/202604/766d474cd58fe990a86428665247e75d.png`,
        extra: '',
      },
      label: '',
      extra: `${MOGGY}/img/202604/1b08b265e0de2c1f0d71c847f40feae4.png`,
    });
  });

  it('皮肤不存在时回包无 f4：skin=null，ttl 仍在', async () => {
    const resp = encode(GetRedPackSkin.respSchema, { traceId: '', ttl: 43200 });
    const result = await GetRedPackSkin.invoke(makeNative(resp), 7, { skinId: 999999 });
    expect(result.skin).toBeNull();
    expect(result.ttl).toBe(43200);
  });

  it('缺少可选文案字段时不抛错，归一到空串', () => {
    const resp = encode(GetRedPackSkin.respSchema, {
      skin: { id: 2000, state: 1, name: 'x' },
    });
    const parsed = decode(GetRedPackSkin.respSchema, resp) as Record<string, unknown>;
    const result: RedPackSkinResponse = GetRedPackSkin.deserialize(parsed);
    expect(result.skin).toMatchObject({
      id: 2000,
      name: 'x',
      cover: { label: '', url: '' },
      jump: { label: '', url: '', extra: '' },
      image: '',
      label: '',
      extra: '',
      background: { flag: 0, url: '', extra: '' },
    });
  });
});
