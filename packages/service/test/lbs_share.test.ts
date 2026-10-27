/**
 * LocationShareService 的离线单测：断言三条命令真正上 wire 的 cmd / body，
 * 并钉住私聊与群聊的会话键差异。不连任何网络。
 *
 * 报文里的每个字节都对着真机抓包核对过（见 `@weq/protocol` 的 `msg/lbs-share`）。
 */

import { describe, expect, it } from 'vitest';
import { LocationShareService } from '../src/account/lbs_share';
import {
  buildShareLocationElements,
  decode,
  QueryLocation,
  ReportLocation,
  StartLocationShare,
} from '@weq/protocol';

interface TrpcCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
  needSign: boolean;
}

function fakeNative() {
  const trpc: TrpcCall[] = [];
  return {
    trpc,
    sendPacket: async (
      pid: number,
      cmd: string,
      body: Buffer,
      needSign: boolean,
    ): Promise<Buffer> => {
      trpc.push({ pid, cmd, body: new Uint8Array(body), needSign });
      return Buffer.alloc(0);
    },
  };
}

const PID = 4321;
const SELF = 2863253201;
const PEER = 1707889225;
const GROUP = 673646675;
const LNG = 103.931543;
const LAT = 30.75535;

function makeService(nt: ReturnType<typeof fakeNative>) {
  return new LocationShareService(nt, () => PID);
}

describe('LocationShareService', () => {
  it('start(c2c) 走 room_operation，不签名，会话键按 uin 升序', async () => {
    const nt = fakeNative();
    await makeService(nt).start({
      scene: 'c2c',
      peer: PEER,
      selfUin: SELF,
      longitude: LNG,
      latitude: LAT,
    });

    expect(nt.trpc).toHaveLength(1);
    const call = nt.trpc[0]!;
    expect(call.pid).toBe(PID);
    expect(call.cmd).toBe('QQLBSShareSvc.room_operation');
    expect(call.needSign).toBe(false);

    const body = decode(StartLocationShare.reqSchema, call.body);
    // 私聊会话键按 uin 升序（小号在前），不是「对端/自己」。
    expect(body.session).toEqual({ scene: 2, uinA: BigInt(PEER), uinB: BigInt(SELF) });
    expect(body.op).toBe(1);
    expect(body.interval).toBe(2);
    expect(body.longitude).toBeCloseTo(LNG, 6);
    expect(body.latitude).toBeCloseTo(LAT, 6);
  });

  it('c2c 反方向发包产生完全相同的 wire（服务端只认规范顺序）', async () => {
    // 回归：早期实现把「对端」写 field2、「自己」写 field3，于是「自己是大号」
    // 时碰巧正确、「自己是小号」时服务端回 10001 param error。同一对号的两个方向
    // 必须逐字节相同 —— 安卓抓包里两个账号各自发包，请求体完全一致。
    const forward = fakeNative();
    await makeService(forward).start({
      scene: 'c2c',
      peer: PEER,
      selfUin: SELF,
      longitude: LNG,
      latitude: LAT,
    });
    const backward = fakeNative();
    await makeService(backward).start({
      scene: 'c2c',
      peer: SELF,
      selfUin: PEER,
      longitude: LNG,
      latitude: LAT,
    });

    expect(Buffer.from(backward.trpc[0]!.body).equals(Buffer.from(forward.trpc[0]!.body))).toBe(
      true,
    );
    const body = decode(StartLocationShare.reqSchema, backward.trpc[0]!.body);
    expect(body.session).toEqual({ scene: 2, uinA: BigInt(PEER), uinB: BigInt(SELF) });
  });

  it('start(group) 会话键是 {scene:1, peer:群号, selfUin:0}', async () => {
    const nt = fakeNative();
    await makeService(nt).start({
      scene: 'group',
      peer: GROUP,
      selfUin: SELF,
      longitude: LNG,
      latitude: LAT,
    });

    const body = decode(StartLocationShare.reqSchema, nt.trpc[0]!.body);
    expect(body.session).toEqual({ scene: 1, uinA: BigInt(GROUP) });
  });

  it('report(group) 的会话键仍是 {scene:2, peer:群号, selfUin}', async () => {
    // 抓包里两种场景的 report_location 1.1 都是 2、1.3 都是自己 —— 不跟场景走。
    const nt = fakeNative();
    await makeService(nt).report({
      scene: 'group',
      peer: GROUP,
      selfUin: SELF,
      longitude: LNG,
      latitude: LAT,
    });

    expect(nt.trpc[0]!.cmd).toBe('QQLBSShareSvc.report_location');
    const body = decode(ReportLocation.reqSchema, nt.trpc[0]!.body);
    expect(body.session).toEqual({ scene: 2, uinA: BigInt(GROUP), uinB: BigInt(SELF) });
    // extra 缺省 0 → proto3 省略，解码回来自然没有这个字段。
    expect(body.extra).toBeUndefined();
  });

  it('report(c2c) 带 extra', async () => {
    const nt = fakeNative();
    await makeService(nt).report({
      scene: 'c2c',
      peer: PEER,
      selfUin: SELF,
      longitude: LNG,
      latitude: LAT,
      extra: 208.03,
    });

    const body = decode(ReportLocation.reqSchema, nt.trpc[0]!.body);
    expect(body.extra).toBeCloseTo(208.03, 2);
  });

  it('query 默认 mode=1，群聊会话键同 room_operation', async () => {
    const nt = fakeNative();
    await makeService(nt).query({ scene: 'group', peer: GROUP, selfUin: SELF });

    expect(nt.trpc[0]!.cmd).toBe('QQLBSShareSvc.room_query');
    const body = decode(QueryLocation.reqSchema, nt.trpc[0]!.body);
    expect(body.session).toEqual({ scene: 1, uinA: BigInt(GROUP) });
    expect(body.mode).toBe(1);
  });

  it('私聊 start 缺 selfUin 直接报错，不发包', async () => {
    const nt = fakeNative();
    await expect(
      makeService(nt).start({
        scene: 'c2c',
        peer: PEER,
        selfUin: 0,
        longitude: LNG,
        latitude: LAT,
      }),
    ).rejects.toThrow(/selfUin/);
    expect(nt.trpc).toHaveLength(0);
  });

  it('坐标越界直接报错', async () => {
    const nt = fakeNative();
    await expect(
      makeService(nt).start({
        scene: 'c2c',
        peer: PEER,
        selfUin: SELF,
        longitude: 999,
        latitude: LAT,
      }),
    ).rejects.toThrow(/longitude/);
    expect(nt.trpc).toHaveLength(0);
  });
});

describe('buildShareLocationElements', () => {
  it('私聊只有灰条 + 文本兜底', () => {
    const elements = buildShareLocationElements('c2c');
    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({ kind: 'raw' });
    expect(elements[1]).toMatchObject({ kind: 'raw' });
  });

  it('群聊额外带 generalFlags(37)，否则卡片点不了', () => {
    const elements = buildShareLocationElements('group');
    expect(elements).toHaveLength(3);
    const general = elements[1] as { kind: 'raw'; elem: Record<string, unknown> };
    expect(general.elem).toHaveProperty('generalFlags');
  });

  it('灰条是 commonElem serviceType=31，文案「发起了位置共享」', () => {
    const [tip] = buildShareLocationElements('c2c') as {
      kind: 'raw';
      elem: { commonElem: { serviceType: number; pbElem: Uint8Array; businessType: number } };
    }[];
    expect(tip!.elem.commonElem.serviceType).toBe(31);
    expect(tip!.elem.commonElem.businessType).toBe(1);
    const text = new TextDecoder().decode(tip!.elem.commonElem.pbElem.subarray(2));
    expect(text).toBe('发起了位置共享');
  });
});
