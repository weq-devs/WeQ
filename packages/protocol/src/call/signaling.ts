/**
 * TRTC 语音通话信令（MSF / SSO）。
 *
 * 三层协议的第一层：借同机 QQ 的凭据把「开房间 → 邀请」这两条 trpc 请求发出去，
 * 拿回房间号、鉴权密钥和中继服务器列表；挂断时再发一条登出。
 *
 * 这三条命令都是 `trpc.qqrtc.av_appsvr.AvAppsvr.*`，走裸 SSO（不经 OIDB 信封），
 * 因此不签名 —— LagrangeV2 的 `WhiteListCommand` 里没有它们，名单外多签没有收益。
 *
 * 私聊用 `AvAppsvr`（c2c），群聊用 `MavAppsvr`（群房间）走 OIDB 信封，
 * 见 {@link GROUP_OIDB}。两种场景的房间语义不同，不要混用。
 */

import { encode, message, type ProtoMessage } from '../protobuf';
import { parsePb } from './gcs';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';

/** 私聊（c2c）信令命令。 */
export const C2C_SSO_CMD = {
  createRoom: 'trpc.qqrtc.av_appsvr.AvAppsvr.SsoCreateRoom',
  inviteUser: 'trpc.qqrtc.av_appsvr.AvAppsvr.SsoInviteUser',
  acceptInvite: 'trpc.qqrtc.av_appsvr.AvAppsvr.SsoAcceptInvite',
  logout: 'trpc.qqrtc.av_appsvr.AvAppsvr.SsoLogOut',
} as const;

/** 群聊信令命令。走 OIDB，不在这里用 `invokeTrpc`。 */
export const GROUP_SSO_CMD = {
  createRoom: 'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoCreateRoom',
  enterRoom: 'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoEnterRoom',
  deleteUser: 'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoDeleteUser',
} as const;

/** 群聊信令的 OIDB 信封命令号。 */
export const GROUP_OIDB = {
  createRoom: { command: 4752, subCommand: 0 },
  enterRoom: { command: 4753, subCommand: 0 },
  deleteUser: { command: 4754, subCommand: 0 },
} as const;

/**
 * 通话场景。
 *
 * `createRoom` 用 1（音频）；`inviteUser` 的 `common.scene` 固定写 4 —— 邀请
 * 与开房是两套语义，不是同一个枚举的成员。挂断用 1003（与 GCS 的登出 body_type 同源）。
 */
export const CALL_SCENE = {
  c2cAudio: 1,
  c2cVideo: 2,
  groupAudio: 3,
  groupVideo: 5,
  /** 邀请对端。 */
  invite: 4,
  /** 主动挂断（SEND 方向）。 */
  logout: 1003,
  /** 服务端回的挂断通知（RECV 方向）。 */
  logoutAck: 1004,
} as const;

/** 音频编码类型（`MediaCtrlPush` 的 `audio_config.codec_type`）。 */
export const AUDIO_CODEC_TYPE = {
  opus: 4129,
  penguins: 4130,
} as const;

// ─────────────────────────── wire schemas ───────────────────────────

const f = (
  name: string,
  tag: number,
  type: ProtoMessage['fields'][number]['type'],
  extra: Partial<{ repeated: boolean; force: boolean }> = {},
) => ({ name, tag, type, ...extra });

/**
 * 往已编码的消息前面接一个 fixed32 字段（wire type 5）。
 *
 * `@weq/protocol` 的 protobuf 运行时只有 varint 与 length-delimited 两种
 * wire type；通话里恰好有两处必须用 fixed32（开房的 `ipStack`、回包服务器表的
 * `ip` / `altIp`），写成 varint 服务端不报错、但会当未知字段丢掉 —— 属于
 * 「能跑但行为不对」的那类错误，所以这里显式补上。
 *
 * 调用方负责让 schema 里不再包含该字段，避免同一个 tag 出现两种 wire type。
 */
function fixed32Field(field: number, value: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = (field << 3) | 5;
  out[1] = value & 0xff;
  out[2] = (value >>> 8) & 0xff;
  out[3] = (value >>> 16) & 0xff;
  out[4] = (value >>> 24) & 0xff;
  return out;
}

/** 开房参数里的 IP 栈标识（fixed32）。 */
export const CALL_IP_STACK = 88;

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 写一个 varint 字段。 */
function varintField(field: number, value: number): Uint8Array {
  const tag = (field << 3) | 0;
  const bytes: number[] = [];
  let n = value >>> 0;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Uint8Array.from([tag, ...bytes]);
}

/** 写一个 length-delimited 字段（只有字段头，不含内部消息的 schema）。 */
function pbBytes(field: number, body: Uint8Array): Uint8Array {
  const tag = (field << 3) | 2;
  const len: number[] = [];
  let n = body.length;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    len.push(b);
  } while (n > 0);
  return concatBytes([Uint8Array.from([tag, ...len]), body]);
}

/** `uid_type` 恒为 2（uid 形态，非 uin 形态）。 */
export const USER_INFO: ProtoMessage = message([
  f('uid', 2, 'string'),
  f('uidType', 3, 'uint32', { force: true }),
]);

/** `self_info` / `peer` 里包一层的用户信息。 */
export const USER_WRAPPER: ProtoMessage = message([f('user', 1, USER_INFO)]);

/**
 * 房间公共段。
 *
 * `sessionId` 只在服务端回包（以及后续邀请 / 挂断）里有值：开房请求里它是 0，
 * 拿到回包后原样带回，服务端靠它把同一次通话的若干请求串起来。
 */
export const C2C_MODE_COMMON: ProtoMessage = message([
  f('roomId', 1, 'uint64'),
  f('sessionId', 2, 'uint64'),
  f('relationId', 3, 'uint32', { force: true }),
  f('scene', 4, 'uint32', { force: true }),
  f('selfInfo', 25, USER_WRAPPER),
]);

/** 媒体协商。私聊里对端 uid 写在这里（`peerWrapper`），不是顶层字段。 */
export const MEDIA_CONFIG: ProtoMessage = message([
  f('f2', 2, 'uint32', { force: true }),
  f('f3', 3, 'uint32', { force: true }),
  f('f5', 5, 'uint32', { force: true }),
  f('f8', 8, 'uint32', { force: true }),
  f('f9', 9, 'uint32', { force: true }),
  f('peer', 13, USER_WRAPPER),
]);

/**
 * 开房参数。
 *
 * `ipStack` 是 fixed32（wire type 5），不是 varint —— 写成 varint 服务端会当
 * 未知字段丢掉，且整包仍能解析，属于「不报错但行为不对」的那类错误。
 */
export const CREATE_ROOM_PARAMS: ProtoMessage = message([
  f('audio', 1, 'uint32', { force: true }),
  f('video', 2, 'uint32', { force: true }),
  f('f3', 3, 'uint32', { force: true }),
  f('f5', 5, 'uint32', { force: true }),
  f('media', 7, MEDIA_CONFIG),
  f('f8', 8, 'uint32', { force: true }),
  f('f10', 10, 'bytes'),
  f('f12', 12, 'uint32', { force: true }),
  f('f13', 13, 'uint32', { force: true }),
  f('f14', 14, 'uint32', { force: true }),
  f('f15', 15, 'uint32', { force: true }),
]);

export const C2C_CREATE_ROOM_REQ: ProtoMessage = message([
  f('common', 1, C2C_MODE_COMMON),
  f('params', 2, CREATE_ROOM_PARAMS),
]);

/** 邀请参数。字段 3/4/5/12/13 的值是抓包确认的固定组合。 */
export const INVITE_PARAMS: ProtoMessage = message([
  f('f3', 3, 'uint32', { force: true }),
  f('f4', 4, 'uint32', { force: true }),
  f('f5', 5, 'uint32', { force: true }),
  f('f12', 12, 'uint32', { force: true }),
  f('f13', 13, 'uint32', { force: true }),
]);

/** 注意 `params` 在字段 3，不是 2。 */
export const C2C_INVITE_USER_REQ: ProtoMessage = message([
  f('common', 1, C2C_MODE_COMMON),
  f('params', 3, INVITE_PARAMS),
]);

/** 挂断原因：2 = 用户主动结束。 */
export const LOGOUT_REASON_USER = 2;

/** 挂断请求的 `reason` 在字段 7（不是 8）。 */
export const C2C_LOGOUT_REQ: ProtoMessage = message([
  f('common', 1, C2C_MODE_COMMON),
  f('reason', 7, message([f('code', 1, 'uint32', { force: true })])),
]);

/** 中继服务器。`ip` / `altIp` 是 fixed32，按小端存 IPv4 网络序。 */
export const RELAY_SERVER: ProtoMessage = message([
  f('ip', 1, 'uint32'),
  f('port', 2, 'uint32'),
  f('type', 3, 'uint32'),
  f('altIp', 4, 'uint32'),
]);

export const RSP_MEDIA_CONFIG: ProtoMessage = message([
  f('f1', 1, 'uint32'),
  f('f2', 2, 'uint32'),
  f('f3', 3, 'uint32'),
]);

export const CREATE_ROOM_RSP_PARAMS: ProtoMessage = message([
  f('f1', 1, 'uint32'),
  f('authKey', 3, 'bytes'),
  f('f4', 4, 'uint32'),
  f('servers', 6, RELAY_SERVER, { repeated: true }),
  f('mediaConfig', 9, RSP_MEDIA_CONFIG),
  f('f10', 10, 'uint32'),
  f('f18', 18, 'uint32'),
]);

export const C2C_CREATE_ROOM_RSP: ProtoMessage = message([
  f('common', 1, C2C_MODE_COMMON),
  f('params', 3, CREATE_ROOM_RSP_PARAMS),
]);

/**
 * 邀请回包。
 *
 * 真正有用的是字段 4 里的 `authToken` —— relay 的 `GET_IN` 与心跳都靠它做准入，
 * 缺了它中继会静默丢包（不报错）。字段 4 里还带了服务端分配的端口 / 通道信息，
 * 这里只取 token。
 */
export const INVITE_USER_RSP: ProtoMessage = message([
  f('common', 1, C2C_MODE_COMMON),
  f('params', 4, message([f('authToken', 2, 'uint32')])),
]);

// ─────────────────────────── 结果类型 ───────────────────────────

/** 中继 / GCS 服务器。 */
export interface CallServer {
  ip: string;
  port: number;
  /**
   * 1 = GCS（控制面 + 音频），2 = Relay（中继通道）。
   *
   * 服务端同时给 IPv4 与 IPv6 两种记录：带 `ip` 的那些是真 IPv4；只有 `altIp`
   * 的一批是同一台机器的 IPv4 备用地址，`ip` 缺省时用它兜底即可。
   */
  type: number;
}

/** 开房结果。 */
export interface CallRoom {
  roomId: bigint;
  sessionId: bigint;
  relationId: number;
  /** 80 字节鉴权密钥，GCS 的 head 字段 5 与登出包都要它。 */
  authKey: Uint8Array<ArrayBufferLike>;
  servers: CallServer[];
}

/**
 * fixed32 → 点分 IPv4。
 *
 * protobuf 规定 fixed32 在 wire 上是小端，但通话服务端这里存的是**网络序**的
 * IPv4 —— 0x1d e9 ed 1d 读成 29.237.237.29 才是对的，按小端读会得到镜像地址。
 */
function ipv4FromFixed32(value: number | bigint | undefined): string | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/** `relationId` 由客户端自己选，服务端只按它归类同一次会话。 */
export function nextRelationId(): number {
  return 15000 + Math.floor(Math.random() * 1000);
}

function baseCommon(roomId: bigint, relationId: number, scene: number, selfUid: string) {
  return {
    roomId,
    sessionId: 0n,
    relationId,
    scene,
    selfInfo: { user: { uid: selfUid, uidType: 2 } },
  };
}

// ─────────────────────────── 私聊信令 ───────────────────────────

/**
 * 开房 / 邀请的媒体类型。
 *
 * ⚠️ 视频**不是**靠改 `scene` 或 `params.video` 区分的 —— 实测这两项在语音和
 * 视频通话里都是 1 / 0。真正的差异在下面这几项（2026-10-25 抓包逐字节比对）：
 *
 * | 字段 | 语音 | 视频 |
 * | --- | --- | --- |
 * | `params.f3` | 1 | 0 |
 * | `params.ipStack` | 88 | 12656 |
 * | `params.f13` | 1 | 3 |
 * | `invite.params.f3` | 5 | 15 |
 * | `invite.params.f4` | 10056 | 10063 |
 *
 * 所以按场景查表，而不是拼一堆 if。
 */
export interface MediaProfile {
  /** `params.f3`。 */
  f3: number;
  /** `params.ipStack`（fixed32）。 */
  ipStack: number;
  /** `params.f13`。 */
  f13: number;
  /** `invite.params.f3`。 */
  inviteF3: number;
  /** `invite.params.f4`。 */
  inviteF4: number;
}

export const MEDIA_PROFILE: Record<'audio' | 'video', MediaProfile> = {
  audio: { f3: 1, ipStack: CALL_IP_STACK, f13: 1, inviteF3: 5, inviteF4: 10056 },
  video: { f3: 0, ipStack: 12656, f13: 3, inviteF3: 15, inviteF4: 10063 },
};

/** 开房 / 邀请请求里的媒体类型。 */
export type CallMedia = keyof typeof MEDIA_PROFILE;

/** `SsoCreateRoom`。 */
export const CreateRoom: TrpcSpec<
  { selfUid: string; peerUid: string; relationId: number; media?: CallMedia },
  CallRoom
> = {
  cmd: C2C_SSO_CMD.createRoom,
  reqSchema: C2C_CREATE_ROOM_REQ,
  respSchema: C2C_CREATE_ROOM_RSP,
  // `ipStack` 是 fixed32，运行时表达不了，参数体逐字段手工拼。
  encodeRequest: ({ selfUid, peerUid, relationId, media: kind = 'audio' }) => {
    const profile = MEDIA_PROFILE[kind];
    const common = encode(C2C_MODE_COMMON, {
      ...baseCommon(0n, relationId, CALL_SCENE.c2cAudio, selfUid),
    });
    // 对端 uid 写在 media.peer 里 —— c2c 没有顶层的 peer 字段。
    const media = concatBytes([
      varintField(2, 1),
      varintField(3, 0),
      varintField(5, 0),
      varintField(8, 0),
      varintField(9, 0),
      pbBytes(13, pbBytes(1, encode(USER_INFO, { uid: peerUid, uidType: 2 }))),
    ]);
    const params = concatBytes([
      varintField(1, 1), // audio：视频通话里也恒为 1
      varintField(2, 0), // video：语音与视频都是 0
      varintField(3, profile.f3),
      fixed32Field(4, profile.ipStack),
      varintField(5, 1),
      pbBytes(7, media),
      varintField(8, 0),
      pbBytes(10, new Uint8Array(0)),
      varintField(12, 0),
      varintField(13, profile.f13),
      varintField(14, 0),
      varintField(15, 0),
    ]);
    return concatBytes([pbBytes(1, common), pbBytes(2, params)]);
  },
  serialize: ({ selfUid, peerUid, relationId, media: kind = 'audio' }) => ({
    common: baseCommon(0n, relationId, CALL_SCENE.c2cAudio, selfUid),
    params: {
      f3: MEDIA_PROFILE[kind].f3,
      f13: MEDIA_PROFILE[kind].f13,
      media: { peer: { user: { uid: peerUid, uidType: 2 } } },
    },
  }),
  // `ip` / `altIp` 是 fixed32：运行时的 schema 解码会把 wire 不匹配的字段整段跳过，
  // 所以服务器表从原始字节里读。
  decodeResponse: decodeCreateRoomRspBytes,
  deserialize: (body) => decodeCreateRoomRspBytes(encode(C2C_CREATE_ROOM_RSP, body)),
};

/**
 * `SsoInviteUser` —— 把对端拉进房间（对方客户端此时开始振铃）。
 *
 * 必须带开房回包里的 `sessionId`；`relationId` 递增一位即可，与服务端无约定。
 * 视频的 `params.f3/f4` 与语音不同，见 {@link MEDIA_PROFILE}。
 */
export const InviteUser: TrpcSpec<
  {
    selfUid: string;
    roomId: bigint;
    sessionId: bigint;
    relationId: number;
    media?: CallMedia;
  },
  { authToken: number }
> = {
  cmd: C2C_SSO_CMD.inviteUser,
  reqSchema: C2C_INVITE_USER_REQ,
  respSchema: INVITE_USER_RSP,
  serialize: ({ selfUid, roomId, sessionId, relationId, media: kind = 'audio' }) => {
    const profile = MEDIA_PROFILE[kind];
    return {
      common: { ...baseCommon(roomId, relationId, CALL_SCENE.invite, selfUid), sessionId },
      params: { f3: profile.inviteF3, f4: profile.inviteF4, f5: 0, f12: 0, f13: 0 },
    };
  },
  deserialize: (body) => {
    const params = (body.params ?? {}) as Record<string, unknown>;
    return { authToken: Number(params.authToken ?? 0) };
  },
};

/**
 * `SsoLogOut` —— 挂断。
 *
 * 顺序要紧：**先**给 GCS 发 UDP 登出（见 `call/gcs.ts` 的 `buildGcsLogout`），
 * **再**发这条 MSF 登出。反过来中继不会拆连接，对端会一直停在「通话中」。
 */
export const Logout: TrpcSpec<{ selfUid: string; roomId: bigint; relationId: number }, void> = {
  cmd: C2C_SSO_CMD.logout,
  reqSchema: C2C_LOGOUT_REQ,
  respSchema: message([]),
  serialize: ({ selfUid, roomId, relationId }) => ({
    common: baseCommon(roomId, relationId, CALL_SCENE.logout, selfUid),
    reason: { code: LOGOUT_REASON_USER },
  }),
  deserialize: () => undefined,
};

// ─────────────────────────── 便捷入口 ───────────────────────────

export type CallSignalingNative = Parameters<typeof invokeTrpc>[0];

/**
 * 开一间私聊房（语音或视频），并邀请对端。
 *
 * 两步之间失败时已经开的房间会泄漏在服务端（无副作用，到期自清），调用方
 * 拿到异常后不必自己回收。
 *
 * `media` 只影响两条信令里的媒体档位（见 {@link MEDIA_PROFILE}），房间本身
 * 是同一套；视频画面要靠 `0x5b subType=2` 的媒体流，信令只负责把对端叫起来。
 */
export async function startC2CCall(
  nt: CallSignalingNative,
  pid: number,
  params: { selfUid: string; peerUid: string; media?: CallMedia },
): Promise<{ room: CallRoom; authToken: number }> {
  const relationId = nextRelationId();
  const media = params.media ?? 'audio';
  const room = await invokeTrpc(nt, pid, CreateRoom, {
    selfUid: params.selfUid,
    peerUid: params.peerUid,
    relationId,
    media,
  });
  const { authToken } = await invokeTrpc(nt, pid, InviteUser, {
    selfUid: params.selfUid,
    roomId: room.roomId,
    sessionId: room.sessionId,
    relationId: relationId + 1,
    media,
  });
  return { room, authToken };
}

/** 发挂断信令（GCS 登出之后调用）。 */
export async function endC2CCall(
  nt: CallSignalingNative,
  pid: number,
  params: { selfUid: string; roomId: bigint; relationId: number },
): Promise<void> {
  await invokeTrpc(nt, pid, Logout, params);
}

/** 序列化工具：单测里比对 wire 字节用。 */
export function encodeCreateRoomReq(params: {
  selfUid: string;
  peerUid: string;
  relationId: number;
  media?: CallMedia;
}): Uint8Array {
  return CreateRoom.encodeRequest!(params);
}

export function decodeCreateRoomRsp(bytes: Uint8Array): CallRoom {
  return decodeCreateRoomRspBytes(bytes);
}

/**
 * 从原始字节解析开房回包。
 *
 * 为什么不用 schema 解码：服务器表里的 `ip`（字段 1）与 `altIp`（字段 4）是
 * **fixed32**，而运行时的 `decode` 遇到 wire type 与 schema 对不上的字段会整段
 * 跳过 —— 结果就是「服务器列表是空的」，不报错。
 */
export function decodeCreateRoomRspBytes(bytes: Uint8Array): CallRoom {
  const outer = parsePb(bytes);
  const commonBytes = outer.find((x) => x.field === 1 && x.wire === 2)?.bytes;
  const paramsBytes = outer.find((x) => x.field === 3 && x.wire === 2)?.bytes;
  if (!commonBytes) {
    return { roomId: 0n, sessionId: 0n, relationId: 0, authKey: new Uint8Array(0), servers: [] };
  }
  const common = parsePb(commonBytes);
  const varintOf = (fields: typeof common, field: number) =>
    fields.find((x) => x.field === field && x.wire === 0)?.value;

  const servers: CallServer[] = [];
  let authKey: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  if (paramsBytes) {
    for (const field of parsePb(paramsBytes)) {
      if (field.field === 3 && field.wire === 2 && field.bytes) authKey = field.bytes;
      if (field.field !== 6 || field.wire !== 2 || !field.bytes) continue;
      const s = parsePb(field.bytes);
      const fixed = (n: number) => s.find((x) => x.field === n && x.wire === 5)?.fixed32;
      // 只有 altIp 的记录是同一台机器的 IPv4 备用地址，ip 缺省时用它。
      const ip = ipv4FromFixed32(fixed(1)) ?? ipv4FromFixed32(fixed(4));
      const port = Number(s.find((x) => x.field === 2 && x.wire === 0)?.value ?? 0n);
      const type = Number(s.find((x) => x.field === 3 && x.wire === 0)?.value ?? 0n);
      if (!ip || !port) continue;
      servers.push({ ip, port, type });
    }
  }
  return {
    roomId: varintOf(common, 1) ?? 0n,
    sessionId: varintOf(common, 2) ?? 0n,
    relationId: Number(varintOf(common, 3) ?? 0n),
    authKey,
    servers,
  };
}
