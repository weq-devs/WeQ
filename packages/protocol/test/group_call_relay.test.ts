/**
 * 群通话 `0x02` 通道回归测试。
 *
 * 黄金样本**全部是 2026-11-05 的真实抓包字节**（见 `test/fixtures/group_call_capture.ts`），
 * 不是自造的：上一版靠自造夹具，把「应答多 5 个前导 0」「`0x73` 密钥只有 74B」
 * 「退出是 0x7f」三个错误全掩盖过去了。
 */

import { describe, expect, it } from 'vitest';
import { GROUP_SESSION_KEY_LEN } from '../src/group-call/gcs';
import {
  GROUP_RELAY_ETX,
  GROUP_RELAY_STX,
  GROUP_STREAM_LEN,
  GroupMemberEvent,
  GroupRelayCmd,
  buildGroupAuth,
  buildGroupExit,
  buildGroupKeepaliveAck,
  buildGroupMemberStateAck,
  buildGroupMicState,
  buildGroupStreamSubscribe,
  groupRelayCmdName,
  parseGroupAuthRsp,
  parseGroupCameraState,
  parseGroupKeepalive,
  parseGroupMemberState,
  parseGroupMicState,
  parseGroupRelay,
  parseGroupStreamSubscribe,
} from '../src/group-call/relay';
import {
  authK1,
  authK2,
  authRspOk,
  authRspRepeat,
  cameraOff,
  cameraOn,
  exit as exitPacket,
  keepalive,
  keepaliveAck,
  mediaDown,
  memberPeerJoin,
  memberSelfMuted,
  memberSelfReady,
  micMutePeer,
  micSelfMute,
  micSelfUnmute,
  subscribeEmpty,
  subscribeTwo,
} from './fixtures/group_call_capture';

const hex = (s: string) => new Uint8Array(Buffer.from(s.replace(/\s/g, ''), 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** 自己的 uin（实机 1707889225）。 */
const SELF_UIN = 0x65cc5249;
/** #FFFFFF 的 uin。 */
const PEER_UIN = 0xaf47d754;
/** 本端流标识（③ 这一通的值，每通电话不同）。 */
const SELF_STREAM = hex('18 57 06 aa 67 7e 00');
/** ③ 的服务端下发密钥 k2。 */
const KEY_K2 = hex(
  '6a74c840064c60168497a52714f347b66fe022f80ebe111707916e794ca4cd53e81e3240' +
    '15f98f4a7df11225f0549a3748642168f07791c752fc78e860fe5ef86d7e5205ab4661e6784' +
    '69c91988cabdd4e3862f2c9554394',
);
/** 开房回包的 authKey（k1）。 */
const KEY_K1 = hex(
  '38076808cfff5bf6c85bbf68f1c194433ef4d92f0b964a53d4f1d70a55e77656ffde191459' +
    'd95cfb19fa4a5c33955c8b1b6378084dad1dd0a6e5c7eb4ccf815d34103929d0bad5e824d' +
    'f8e7e40f1e608f8c6cf466847123e',
);

describe('0x02 包格式', () => {
  it('解析前缀字段', () => {
    const pkt = parseGroupRelay(memberSelfReady)!;
    expect(pkt.cmd).toBe(GroupRelayCmd.memberState);
    expect(pkt.kind).toBe(0x04);
    expect(pkt.route).toBe(0x63dfdf);
    expect(pkt.ownerUin).toBe(SELF_UIN);
    expect(toHex(pkt.stream!)).toBe('185706aa00014a');
    expect(pkt.raw.at(-1)).toBe(GROUP_RELAY_ETX);
  });

  it('首字节不是 0x02 时返回 null', () => {
    expect(parseGroupRelay(hex('28 00 00 00 00'))).toBeNull();
  });

  it('命令号名字表', () => {
    expect(groupRelayCmdName(0x19)).toBe('memberState');
    expect(groupRelayCmdName(0x11)).toBe('exit');
    // 0x7f 在三份抓包里一次都没出现，曾经的「exit=0x7f」是错的。
    expect(groupRelayCmdName(0x7f)).toBe('0x7f');
    expect(groupRelayCmdName(0x99)).toBe('0x99');
  });

  it('下行媒体的 [13:17] 是发流成员，不是 roomId', () => {
    expect(parseGroupRelay(mediaDown)!.ownerUin).toBe(PEER_UIN);
  });
});

describe('0x19 成员状态', () => {
  it('解出自己：视频开、未静音、事件=更新', () => {
    const st = parseGroupMemberState(parseGroupRelay(memberSelfReady)!.body)!;
    expect(st.uin).toBe(SELF_UIN);
    expect(st.video).toBe(true);
    expect(st.self).toBe(true);
    expect(st.muted).toBe(false);
    expect(st.event).toBe(GroupMemberEvent.update);
    expect(st.seq).toBe(0x24cbf4);
  });

  it('解出对端进房：事件=01、媒体=02、角色=05', () => {
    const st = parseGroupMemberState(parseGroupRelay(memberPeerJoin)!.body)!;
    expect(st.uin).toBe(PEER_UIN);
    expect(st.event).toBe(GroupMemberEvent.join);
    expect(st.video).toBe(false);
    expect(st.self).toBe(false);
    expect(st.role).toBe(0x05);
  });

  it('uin 是 4 字节大端（0xaf47d754 = 2940720980）', () => {
    expect(parseGroupMemberState(parseGroupRelay(memberPeerJoin)!.body)!.uin).toBe(2940720980);
  });

  it('自己静音：静音位在 body[23]', () => {
    const st = parseGroupMemberState(parseGroupRelay(memberSelfMuted)!.body)!;
    expect(st.muted).toBe(true);
    expect(st.uin).toBe(SELF_UIN);
  });

  it('事件序号 3 字节递增（21.01 → 43.03）', () => {
    const a = parseGroupMemberState(parseGroupRelay(memberSelfReady)!.body)!.seq;
    const b = parseGroupMemberState(parseGroupRelay(memberSelfMuted)!.body)!.seq;
    expect(b - a).toBe(0x24cbfa - 0x24cbf4);
  });

  it('body 太短时返回 null', () => {
    expect(parseGroupMemberState(new Uint8Array(4))).toBeNull();
  });
});

describe('0x64 摄像头状态', () => {
  it('开（0x08）', () => {
    const st = parseGroupCameraState(parseGroupRelay(cameraOn)!.body)!;
    expect(st.uin).toBe(PEER_UIN);
    expect(st.on).toBe(true);
  });

  it('关（0x00）', () => {
    expect(parseGroupCameraState(parseGroupRelay(cameraOff)!.body)!.on).toBe(false);
  });
});

describe('0x73 麦克风状态', () => {
  it('自己关麦：静音、无目标', () => {
    const st = parseGroupMicState(parseGroupRelay(micSelfMute)!.body)!;
    expect(st.muted).toBe(true);
    expect(st.targetUin).toBeNull();
  });

  it('自己开麦：不静音', () => {
    expect(parseGroupMicState(parseGroupRelay(micSelfUnmute)!.body)!.muted).toBe(false);
  });

  it('静音对端：静音、目标是 af47d754', () => {
    const st = parseGroupMicState(parseGroupRelay(micMutePeer)!.body)!;
    expect(st.muted).toBe(true);
    expect(st.targetUin).toBe(PEER_UIN);
  });

  it('报文里带的是会话密钥 k2（88B，不是旧注释说的 74B 能力块）', () => {
    const st = parseGroupMicState(parseGroupRelay(micSelfMute)!.body)!;
    expect(st.key.length).toBe(GROUP_SESSION_KEY_LEN);
    expect(toHex(st.key)).toBe(toHex(KEY_K2));
  });

  it('构造的包与抓包逐字节相同（自己关麦）', () => {
    const built = buildGroupMicState({
      route: 0x5c1c,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      key: KEY_K2,
      muted: true,
    });
    expect(toHex(built)).toBe(toHex(micSelfMute));
  });

  it('构造的包与抓包逐字节相同（静音对端）', () => {
    const built = buildGroupMicState({
      route: 0x5c2d,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      key: KEY_K2,
      muted: true,
      targetUin: PEER_UIN,
    });
    expect(toHex(built)).toBe(toHex(micMutePeer));
  });

  it('密钥结尾不是 0x94 也要能解（② 的 k2 以 0xbf 结尾）', () => {
    const k2v2 = hex(
      '324ef8b68db7b53a5672b06d985a3c2da653c479e588b95cc58c93b381bb8ca6671e311adf' +
        '525c21e070b45e78d20627ed445d309c666e355836665a59f31d61e0b13e76e4eb66c84e0' +
        '2bb9c399e36e56d854adf7edd32bf',
    );
    const built = buildGroupMicState({
      route: 0,
      ownerUin: SELF_UIN,
      stream: hex('18 b6 06 aa 47 32 00'),
      key: k2v2,
      muted: false,
    });
    const st = parseGroupMicState(parseGroupRelay(built)!.body)!;
    expect(st.muted).toBe(false);
    expect(toHex(st.key)).toBe(toHex(k2v2));
  });
});

describe('0x13 订阅成员流', () => {
  it('构造两个成员的订阅与抓包逐字节相同', () => {
    const built = buildGroupStreamSubscribe({
      route: 0x5c02,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      key: KEY_K2,
      memberUins: [SELF_UIN, PEER_UIN],
    });
    expect(toHex(built)).toBe(toHex(subscribeTwo));
  });

  it('构造 0 个成员的订阅与抓包逐字节相同', () => {
    const built = buildGroupStreamSubscribe({
      route: 0x5c20,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      key: KEY_K2,
      memberUins: [],
    });
    expect(toHex(built)).toBe(toHex(subscribeEmpty));
  });

  it('解析出成员表与密钥', () => {
    const parsed = parseGroupStreamSubscribe(parseGroupRelay(subscribeTwo)!.body)!;
    expect(parsed.memberUins).toEqual([SELF_UIN, PEER_UIN]);
    expect(toHex(parsed.key)).toBe(toHex(KEY_K2));
  });
});

describe('认证与保活', () => {
  it('认证包里的密钥就是 k1，且与抓包逐字节相同', () => {
    const pkt = parseGroupRelay(authK1)!;
    expect(pkt.cmd).toBe(GroupRelayCmd.auth);
    expect(toHex(pkt.body.subarray(9, 97))).toBe(toHex(KEY_K1));
    const built = buildGroupAuth({
      route: 0x5bfe,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      key: KEY_K1,
    });
    expect(toHex(built)).toBe(toHex(authK1));
  });

  it('k2 下发后的重复认证用 k2', () => {
    expect(toHex(parseGroupRelay(authK2)!.body.subarray(9, 97))).toBe(toHex(KEY_K2));
  });

  it('认证成功：没有错误文本', () => {
    const r = parseGroupAuthRsp(parseGroupRelay(authRspOk)!.body);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('');
    expect(r.code).toBe(0x03);
  });

  it('认证回包里的 Repeat 提示不算失败', () => {
    const r = parseGroupAuthRsp(parseGroupRelay(authRspRepeat)!.body);
    expect(r.ok).toBe(true);
    expect(r.message).toBe('Repeat request 3');
  });

  it('保活解析出房间归属 uin', () => {
    expect(parseGroupKeepalive(parseGroupRelay(keepalive)!.body)!.roomUin).toBe(SELF_UIN);
  });

  it('保活应答与抓包逐字节相同（body 16B）', () => {
    const built = buildGroupKeepaliveAck({
      route: 0x7d120c,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      kind: 0x24,
    });
    expect(toHex(built)).toBe(toHex(keepaliveAck));
    expect(parseGroupRelay(built)!.body.length).toBe(16);
  });

  it('成员状态应答（0x1a）与保活应答同构', () => {
    const built = buildGroupMemberStateAck({
      route: 0x63dfdf,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      kind: 0x04,
    });
    const pkt = parseGroupRelay(built)!;
    expect(pkt.cmd).toBe(GroupRelayCmd.memberStateAck);
    expect(pkt.kind).toBe(0x04);
    expect(toHex(pkt.body)).toBe('185706aa677e00010000000100000000');
  });
});

describe('0x11 退出', () => {
  it('解析抓包里的退出包', () => {
    const pkt = parseGroupRelay(exitPacket)!;
    expect(pkt.cmd).toBe(GroupRelayCmd.exit);
    expect(pkt.ownerUin).toBe(SELF_UIN);
  });

  it('构造的退出包与抓包逐字节相同', () => {
    const built = buildGroupExit({
      route: 0x5c3d,
      ownerUin: SELF_UIN,
      stream: SELF_STREAM,
      key: KEY_K2,
    });
    expect(toHex(built)).toBe(toHex(exitPacket));
    expect(built[0]).toBe(GROUP_RELAY_STX);
    expect(built.at(-1)).toBe(GROUP_RELAY_ETX);
  });
});

describe('参数校验', () => {
  it('流标识长度不对时抛错（不再硬编码）', () => {
    expect(() =>
      buildGroupExit({ route: 0, ownerUin: SELF_UIN, stream: new Uint8Array(4), key: KEY_K2 }),
    ).toThrow(/流标识/);
  });

  it('密钥长度不对时抛错', () => {
    expect(() =>
      buildGroupExit({
        route: 0,
        ownerUin: SELF_UIN,
        stream: SELF_STREAM,
        key: new Uint8Array(74),
      }),
    ).toThrow(/会话密钥/);
  });

  it('流标识就是 body 开头的 7 字节', () => {
    expect(GROUP_STREAM_LEN).toBe(7);
    expect(parseGroupRelay(exitPacket)!.stream!.length).toBe(GROUP_STREAM_LEN);
  });
});
