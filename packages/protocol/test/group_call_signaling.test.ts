/**
 * 群通话信令回归测试。
 *
 * 所有期望值都取自 2026-11-05 的真实抓包（`~/call-capture/20261105-*`），
 * 不是凭空构造的 —— 目的是**锁死字段布局**，任何 schema 改动都会让这里的
 * 字节比对失败。
 *
 * 黄金样本来源：
 *   `20261105-groupvideo-events/tcp.json`（一次完整群视频通话：
 *   开房 → 邀请 #FFFFFF → 中途邀请 estkim → 退出）
 */

import { describe, expect, it } from 'vitest';
import { decode } from '../src/protobuf';
import {
  CreateGroupRoom,
  GROUP_INVITE_ROOM_RSP,
  GROUP_SSO_CMD,
  InviteToGroupRoom,
  QueryGroupRoom,
  QUERY_ROOM_WANTED,
  decodeCreateGroupRoomRspBytes,
  decodeQueryRoomRspBytes,
  encodeCreateGroupRoomReq,
  encodeInviteReq,
  encodeQueryReq,
  normalizeQueryRoom,
  type GroupRoomState,
} from '../src/group-call/signaling';

const hex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** 自己的 uid（抓包里的主叫）。 */
const SELF_UID = 'u_mGIBTBW7gF4Wocw8zapc6w';
/** #FFFFFF。 */
const PEER_UID = 'u_tXMK3pknkkMyg69TBiC6xg';

// ─────────────── 抓包原始字节 ───────────────

/** SsoCreateRoom 请求（59B） */
const CREATE_ROOM_REQ_HEX =
  '0a1e080410002218755f6d47494254425737674634576f6377387a6170633677100318cf4e20022803420e1000180a200138d3909cc10240024803';

/** SsoCreateRoom 回包（435B） */
const CREATE_ROOM_RSP_HEX =
  '0a28080410c9a4b1ae062218755f6d47494254425737674634576f6377387a617063367738c9a4b1ae06125838076808cfff5bf6c85bbf68f1c194433ef4d92f0b964a53d4f1d70a55e77656ffde191459d95cfb19fa4a5c33955c8b1b6378084dad1dd0a6e5c7eb4ccf815d34103929d0bad5e824df8e7e40f1e608f8c6cf466847123e321b0a14323430653a3933303a633230303a38663a3a316110ee3c2001321b0a14323430653a3933303a633230303a38643a3a316110ee3c2001321b0a14323430653a3933303a633230303a38613a3a316310f03c200132120a0d3131332e3235302e35382e383110ee3c32120a0d3131332e3235302e35382e343910ee3c32130a0e3131332e3235302e35372e31363610f03c32140a0d3131332e3235302e35382e383110ef3c180132140a0d3131332e3235302e35382e343910ee3c180132150a0e3131332e3235302e35372e31363610ee3c18013a140a0e31312e3134392e3138382e31393610a8c301422c0a0ce4b8ade59bbde794b5e4bfa11206e4b8ade59bbd1a09e59b9be5b79de79c812209e68890e983bde5b88248026208080310b81718e8076a0687e4069dda0e';

/** 从回包 f2 里取的 88 字节 authKey */
const AUTH_KEY_HEX =
  '38076808cfff5bf6c85bbf68f1c194433ef4d92f0b964a53d4f1d70a55e77656ffde191459d95cfb19fa4a5c33955c8b1b6378084dad1dd0a6e5c7eb4ccf815d34103929d0bad5e824df8e7e40f1e608f8c6cf466847123e';

/** SsoInviteRoom 请求（156B，邀请 #FFFFFF） */
const INVITE_REQ_HEX =
  '0a1e080410002218755f74584d4b33706b6e6b6b4d7967363954426943367867280f488a80d01f58d6ceadd70660cf4e6a6c0a5838076808cfff5bf6c85bbf68f1c194433ef4d92f0b964a53d4f1d70a55e77656ffde191459d95cfb19fa4a5c33955c8b1b6378084dad1dd0a6e5c7eb4ccf815d34103929d0bad5e824df8e7e40f1e608f8c6cf466847123e10aa8ddcc201180a200138d3909cc1024002';

/** SsoInviteRoom 回包（32B） */
const INVITE_RSP_HEX = '0a1e08042218755f74584d4b33706b6e6b6b4d79673639544269433678673001';

/** SsoQueryRoom 请求（136B） */
const QUERY_REQ_HEX =
  '08d3909cc1021001100210061005100a100b100c100e10101802226a0a5838076808cfff5bf6c85bbf68f1c194433ef4d92f0b964a53d4f1d70a55e77656ffde191459d95cfb19fa4a5c33955c8b1b6378084dad1dd0a6e5c7eb4ccf815d34103929d0bad5e824df8e7e40f1e608f8c6cf466847123e10aa8ddcc201180a200138d3909cc1022808';

/** SsoQueryRoom 应答（210B，2 人房） */
const QUERY_RSP_HEX =
  '0a08080110d3909cc1020a08080218aa8ddcc2010a04080658010a060805200248020a36080a3218755f6d47494254425737674634576f6377387a61706336773218755f74584d4b33706b6e6b6b4d79673639544269433678670a06080b3a0200000a06080c420200000a06080e200248020a5a08102a0ac9a4b1ae06d4ae9ffa0a52240a2208c9a4b1ae061218755f6d47494254425737674634576f6377387a6170633677180252240a2208d4ae9ffa0a1218755f74584d4b33706b6e6b6b4d79673639544269433678671802180a2001';

// ─────────────── 测试 ───────────────

describe('群通话信令', () => {
  it('命令字走 mav_appsvr，且不签名', () => {
    expect(GROUP_SSO_CMD.createRoom).toBe('trpc.qqrtc.mav_appsvr.MavAppsvr.SsoCreateRoom');
    expect(GROUP_SSO_CMD.inviteRoom).toBe('trpc.qqrtc.mav_appsvr.MavAppsvr.SsoInviteRoom');
    expect(GROUP_SSO_CMD.queryRoom).toBe('trpc.qqrtc.mav_appsvr.MavAppsvr.SsoQueryRoom');
    expect(GROUP_SSO_CMD.multiTerminalSync).toBe(
      'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoMultiTerminalSync',
    );
    expect(CreateGroupRoom.needSign).toBe(false);
    expect(InviteToGroupRoom.needSign).toBe(false);
    expect(QueryGroupRoom.needSign).toBe(false);
  });

  it('开房请求与抓包逐字节一致', () => {
    const bytes = encodeCreateGroupRoomReq({ selfUid: SELF_UID });
    expect(toHex(bytes)).toBe(CREATE_ROOM_REQ_HEX);
  });

  it('邀请请求与抓包逐字节一致（authKey 从开房回包带回）', () => {
    const bytes = encodeInviteReq({
      targetUids: [PEER_UID],
      authKey: hex(AUTH_KEY_HEX),
      now: 1793812310 * 1000,
    });
    expect(toHex(bytes)).toBe(INVITE_REQ_HEX);
  });

  it('查询请求与抓包逐字节一致', () => {
    const bytes = encodeQueryReq({
      roomUin: 673646675,
      authKey: hex(AUTH_KEY_HEX),
    });
    expect(toHex(bytes)).toBe(QUERY_REQ_HEX);
    expect([...QUERY_ROOM_WANTED]).toEqual([1, 2, 6, 5, 10, 11, 12, 14, 16]);
  });

  it('开房回包解出 authKey / 服务器表', () => {
    const room = decodeCreateGroupRoomRspBytes(hex(CREATE_ROOM_RSP_HEX));
    expect(toHex(room.authKey)).toBe(AUTH_KEY_HEX);
    // f1.f2 是**自己 uin**，不是 roomId。
    expect(room.ownerUin).toBe(1707889225);
    expect(room.servers.length).toBeGreaterThan(0);
    expect(room.servers).toEqual(
      expect.arrayContaining([{ ip: '240e:930:c200:8f::1a', port: 7790, backup: false }]),
    );
  });

  it('邀请回包里的 uid 被标成已加入', () => {
    const rsp = InviteToGroupRoom.deserialize(decode(GROUP_INVITE_ROOM_RSP, hex(INVITE_RSP_HEX)));
    expect(rsp.invited).toEqual([{ uid: PEER_UID, accepted: true }]);
  });

  it('查询回包解出 uin ↔ uid 映射', () => {
    const state = decodeQueryRoomRspBytes(hex(QUERY_RSP_HEX));
    // kind=1 的 f2 实测 673646675（三个抓包恒定），不是 uin
    expect(state.ownerUin).toBe(673646675);
    expect(state.members).toEqual([
      { uin: 1707889225, uid: SELF_UID },
      { uin: 2940720980, uid: PEER_UID },
    ]);
  });

  it('成员标识就是 uin（0x19 里那 4 字节）', () => {
    const state = decodeQueryRoomRspBytes(hex(QUERY_RSP_HEX));
    // 0xaf47d754 = 2940720980，抓包 0x19 里反复出现。
    expect(state.members[1]!.uin).toBe(0xaf47d754);
    expect(state.members[0]!.uin).toBe(0x65cc5249);
  });
});

describe('SsoQueryRoom 归一化', () => {
  it('没有 kind=16 时拿不到成员（kind=10 只有 uid）', () => {
    const rsp = {
      items: [
        { kind: 1, f2: 123 },
        { kind: 10, uids: ['u_x'] },
      ],
    };
    const state = normalizeQueryRoom(rsp);
    expect(state.ownerUin).toBe(123);
    expect(state.members).toEqual([]);
  });

  it('空应答不炸', () => {
    expect(normalizeQueryRoom({})).toEqual({ ownerUin: null, members: [] });
  });

  it('成员按 uin 升序（服务端顺序不保证）', () => {
    const state: GroupRoomState = normalizeQueryRoom({
      items: [
        {
          kind: 16,
          mappings: [
            { f1: { uin: 300, uid: 'u_c', f3: 2 } },
            { f1: { uin: 100, uid: 'u_a', f3: 2 } },
            { f1: { uin: 200, uid: 'u_b', f3: 2 } },
          ],
        },
      ],
    });
    expect(state.members.map((m) => m.uin)).toEqual([100, 200, 300]);
  });
});
