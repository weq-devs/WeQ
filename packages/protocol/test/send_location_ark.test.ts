/**
 * SendLocationArk (trpc.qq_lbs.qq_lbs_ark.LocationArk.SsoSendMessage) 的离线单测：
 * 请求编码（黄金字节）+ 参数校验 + invoke 走 native sendPacket。
 *
 * 黄金字节按 wire format 手工构建（0 = 私聊 / 1 = 群聊，peerType=0 也必须上 wire），
 * **地址已脱敏**（`某省某市某区` / `某市某区某路1号`），不含任何真实地理位置。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { SendLocationArk } from '../src/index';
import type { SendLocationArkParams } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

/** 私聊：targetUin=123456789, peerType=0 —— 0 值在 wire 上（tag 2）。 */
const GOLDEN_C2C = hexToBytes(`
  08 95 9A EF 3A 10 00
  1A 16 E6 9F 90 E5 B8 82 E6 9F 90 E5 8C BA E6 9F 90 E8 B7 AF 31 E5 8F B7
  22 12 E6 9F 90 E7 9C 81 E6 9F 90 E5 B8 82 E6 9F 90 E5 8C BA
  2A 09 31 32 2E 33 34 35 36 37 38
  32 0A 31 32 33 2E 34 35 36 37 38 39
`);

/** 群聊：targetUin=987654321, peerType=1。 */
const GOLDEN_GROUP = hexToBytes(`
  08 B1 D1 F9 D6 03 10 01
  1A 16 E6 9F 90 E5 B8 82 E6 9F 90 E5 8C BA E6 9F 90 E8 B7 AF 31 E5 8F B7
  22 12 E6 9F 90 E7 9C 81 E6 9F 90 E5 B8 82 E6 9F 90 E5 8C BA
  2A 09 31 32 2E 33 34 35 36 37 38
  32 0A 31 32 33 2E 34 35 36 37 38 39
`);

const C2C_PARAMS: SendLocationArkParams = {
  targetUin: 123456789,
  peerType: 0,
  address: '某市某区某路1号',
  region: '某省某市某区',
  latitude: '12.345678',
  longitude: '123.456789',
};

const GROUP_PARAMS: SendLocationArkParams = {
  ...C2C_PARAMS,
  targetUin: 987654321,
  peerType: 1,
};

describe('SendLocationArk (trpc LocationArk.SsoSendMessage)', () => {
  it('声明 trpc 命令字', () => {
    expect(SendLocationArk.cmd).toBe('trpc.qq_lbs.qq_lbs_ark.LocationArk.SsoSendMessage');
  });

  it('私聊请求按 RE 布局编码（peerType=0 也在 wire 上）', () => {
    const bytes = encode(SendLocationArk.reqSchema, SendLocationArk.serialize(C2C_PARAMS));
    expect(bytes).toEqual(GOLDEN_C2C);
  });

  it('群聊请求按 RE 布局编码（peerType=1）', () => {
    const bytes = encode(SendLocationArk.reqSchema, SendLocationArk.serialize(GROUP_PARAMS));
    expect(bytes).toEqual(GOLDEN_GROUP);
  });

  it('peerType=0 / 1 都如实上 wire（不被 proto3 省略）', () => {
    const c2c = decode(
      SendLocationArk.reqSchema,
      encode(SendLocationArk.reqSchema, SendLocationArk.serialize(C2C_PARAMS)),
    );
    const group = decode(
      SendLocationArk.reqSchema,
      encode(SendLocationArk.reqSchema, SendLocationArk.serialize(GROUP_PARAMS)),
    );
    expect(c2c.peerType).toBe(0);
    expect(group.peerType).toBe(1);
  });

  it('serialize → decode 往返（uint64 targetUin 解出 bigint）', () => {
    const bytes = encode(SendLocationArk.reqSchema, SendLocationArk.serialize(GROUP_PARAMS));
    const body = decode(SendLocationArk.reqSchema, bytes);
    expect(body).toEqual({
      targetUin: 987654321n,
      peerType: 1,
      address: '某市某区某路1号',
      region: '某省某市某区',
      latitude: '12.345678',
      longitude: '123.456789',
    });
  });

  it('拒绝非法参数（空地址 / 非法 peerType）', () => {
    expect(() => SendLocationArk.serialize({ ...C2C_PARAMS, address: '  ' })).toThrow(/address/);
    expect(() => SendLocationArk.serialize({ ...C2C_PARAMS, region: '' })).toThrow(/region/);
    expect(() =>
      SendLocationArk.serialize({ ...C2C_PARAMS, peerType: 2 as unknown as 0 | 1 }),
    ).toThrow(/peerType/);
  });

  it('invoke 用正确的 cmd 走 sendPacket 并原样返回响应字节', async () => {
    const calls: { pid: number; cmd: string; body: Uint8Array }[] = [];
    const nt = {
      sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        calls.push({ pid, cmd, body: new Uint8Array(body) });
        return Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      },
    };
    const reply = await SendLocationArk.invoke(nt, 4321, C2C_PARAMS);
    expect(reply).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(calls).toHaveLength(1);
    expect(calls[0].pid).toBe(4321);
    expect(calls[0].cmd).toBe('trpc.qq_lbs.qq_lbs_ark.LocationArk.SsoSendMessage');
    expect(calls[0].body).toEqual(GOLDEN_C2C);
  });
});
