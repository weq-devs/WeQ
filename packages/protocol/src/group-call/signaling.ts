/**
 * 群通话信令（MSF / SSO）。
 *
 * 与私聊 `call/signaling.ts` 是**两套命令**：群聊走 `trpc.qqrtc.mav_appsvr.MavAppsvr.*`，
 * 私聊走 `trpc.qqrtc.av_appsvr.AvAppsvr.*`。两者都是裸 SSO（不经 OIDB 信封），
 * 且 **都不签名** —— 2026-11-05 对三份真实抓包离线核验过（判定依据：SSO head 的
 * `reserved` 里有无 tag 24 `SsoSecureInfo`）；同批抓包里
 * `trpc.o3.report.Report.SsoReport` 是签名的，可作为判定器有效的对照。
 *
 * 四条命令：
 *
 * ```text
 * SsoCreateRoom           开房 → roomId / authKey / 服务器表
 * SsoInviteRoom           邀请（可一次多个 uid，可中途再调）
 * SsoQueryRoom            查询房间成员（uin ↔ uid 映射 + 媒体/静音状态）
 * SsoMultiTerminalSync    多端同步（其他设备也响铃）
 * ```
 *
 * ⚠️ **没有挂断信令**。群聊的退出走 UDP `0x02 cmd=0x11`（服务端回 `0x12`），
 * 三份抓包里 `SsoLogOut` 一次都没出现。代码里旧的 `GROUP_OIDB = {4752,4753,4754}` 是错的，
 * 三份抓包中 4752/4753/4754 从未出现。
 *
 * 字段来源：`~/call-capture/20261105-groupvideo-events/`（完整一次通话）与
 * `~/call-capture/20261105-groupaudio/`（3 人语音）。所有 schema 都对着抓包的
 * 原始字节写过回归测试，见 `test/group_call_signaling.test.ts`。
 */

import { encode, message, type ProtoMessage } from '../protobuf';
import { parsePb, pbBytes, pbVarint } from '../call/gcs';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';

// ─────────────────────────── 命令字 ───────────────────────────

/** 群聊信令命令（裸 trpc，无 OIDB 信封）。 */
export const GROUP_SSO_CMD = {
  createRoom: 'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoCreateRoom',
  inviteRoom: 'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoInviteRoom',
  queryRoom: 'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoQueryRoom',
  multiTerminalSync: 'trpc.qqrtc.mav_appsvr.MavAppsvr.SsoMultiTerminalSync',
} as const;

/**
 * 开房场景号（`params.f2`）。
 *
 * 实测 **群语音与群视频都是 3** —— 三次抓包里「视频通话」按钮发起的那次也是 3。
 * 群聊与私聊的根本差异：私聊靠 `params.f3` / `ipStack` / `f13` 一组字段切档位，
 * 群聊的信令**完全不区分语音/视频**，画面靠运行时开摄像头。
 */
export const GROUP_CALL_SCENE = {
  audio: 3,
  /** 未观测到；若将来抓到「直接视频发起」且 `f2=5`，改这里。 */
  video: 3,
} as const;

/** `SsoCreateRoom.params.f3`（能力档）。与私聊 video 档同值。 */
export const GROUP_CAPABILITY_PROFILE = 10063;

/**
 * `SsoInviteRoom.params.f5`。三次抓包恒为 15。
 *
 * 私聊邀请是 `inviteF3`（语音 5 / 视频 15），群聊恒 15。
 */
export const GROUP_INVITE_F5 = 15;

/** `SsoCreateRoom.params.f4 / f5 / f9`。三次抓包恒定。 */
const CREATE_ROOM_F4 = 2;
const CREATE_ROOM_F5 = 3;
const CREATE_ROOM_F9 = 3;

/** `SsoMultiTerminalSync` 的三个常量字段（③ 抓包逐字节核对）。 */
const MULTI_TERMINAL_F1 = 15;
const MULTI_TERMINAL_F2 = 1;

/** `SsoInviteRoom.f13.f2`：实测 0x185706AA，三次抓包恒定。 */
const GROUP_INVITE_MEDIA_F2 = 0x185706aa;
/** `SsoCreateRoom.params.f8` 里除群号外的固定组合（`f2=0 f3=10 f4=1 f8=2`）。 */
const CREATE_ROOM_F8_BASE = { f2: 0, f3: 10, f4: 1, f8: 2 } as const;

// ─────────────────────────── wire schemas ───────────────────────────

const f = (
  name: string,
  tag: number,
  type: ProtoMessage['fields'][number]['type'],
  extra: Partial<{ repeated: boolean; force: boolean }> = {},
) => ({ name, tag, type, ...extra });

/**
 * 用户标识块。
 *
 * `{ f1 = 4, f4 = "u_<uid>" }` —— 群聊与私聊的差别：私聊是
 * `{ f2 = uid, f3 = uidType }`（见 `call/signaling.ts` 的 `USER_INFO`）。
 */
/**
 * 用户标识块：`{ f1=4, f2=0, f4="u_<uid>" }`。
 *
 * 开房请求与邀请目标**用的是同一个结构**（实测逐字节相同），`f2=0` 必须显式
 * 写出（`10 00`），省掉会与真实客户端字节不一致。
 */
export const GROUP_USER: ProtoMessage = message([
  f('f1', 1, 'uint32', { force: true }),
  f('f2', 2, 'uint32', { force: true }),
  f('f4', 4, 'string'),
]);

/** 邀请目标 —— 与 {@link GROUP_USER} 同构，保留别名便于语义区分。 */
export const GROUP_INVITE_TARGET: ProtoMessage = GROUP_USER;

/** `SsoCreateRoom` 请求。 */
export const GROUP_CREATE_ROOM_F8: ProtoMessage = message([
  f('f2', 2, 'uint32', { force: true }),
  f('f3', 3, 'uint32', { force: true }),
  f('f4', 4, 'uint32', { force: true }),
  /** 实测 = 0x28270853 = 673646675，与主叫相关（三次抓包恒定）。 */
  f('f7', 7, 'uint32', { force: true }),
  /** 实测恒为 2。 */
  f('f8', 8, 'uint32', { force: true }),
]);

export const GROUP_CREATE_ROOM_REQ: ProtoMessage = message([
  f('self', 1, GROUP_USER),
  f('scene', 2, 'uint32', { force: true }),
  f('profile', 3, 'uint32', { force: true }),
  f('f4', 4, 'uint32', { force: true }),
  f('f5', 5, 'uint32', { force: true }),
  f('f8', 8, GROUP_CREATE_ROOM_F8),
  f('f9', 9, 'uint32', { force: true }),
]);

/**
 * 服务器/中继条目（回包 `f6`，repeated）。
 *
 * 与私聊不同：**IP 是字符串**（`f1`），不是 fixed32。三份抓包里 IPv6 与 IPv4
 * 混在一张表里，靠内容本身区分。
 */
export const GROUP_SERVER: ProtoMessage = message([
  f('ip', 1, 'string'),
  f('port', 2, 'uint32'),
  /** 1 = 中继/备份；缺省 = 主 GCS。 */
  f('f3', 3, 'uint32', { force: true }),
  f('f4', 4, 'uint32'),
]);

/** 回包 `f12`：媒体参数。 */
export const GROUP_MEDIA_PARAMS: ProtoMessage = message([
  f('f1', 1, 'uint32'),
  f('f2', 2, 'uint32'),
  f('f3', 3, 'uint32'),
]);

/** `SsoCreateRoom` 回包。 */
export const GROUP_CREATE_ROOM_RSP: ProtoMessage = message([
  f(
    'room',
    1,
    message([
      f('f1', 1, 'uint32'),
      /** 实测 = **自己 uin**，不是 roomId。 */
      f('f2', 2, 'uint32'),
      f('f4', 4, 'string'),
      f('f7', 7, 'uint32'),
    ]),
  ),
  /** 88 字节 authKey。 */
  f('authKey', 2, 'bytes'),
  f('servers', 6, GROUP_SERVER, { repeated: true }),
  f('f7', 7, message([f('ip', 1, 'string'), f('port', 2, 'uint32')])),
  f('f8', 8, 'bytes'),
  f('f9', 9, 'uint32'),
  f('f12', 12, GROUP_MEDIA_PARAMS),
]);

/** `SsoInviteRoom` 请求里的 `f13`（套着 authKey 的媒体块）。 */
export const GROUP_INVITE_MEDIA: ProtoMessage = message([
  /** 裸 88 字节 authKey（**不是**嵌套），与开房回包的 `f2` 同源。 */
  f('authKey', 1, 'bytes'),
  /**
   * 字段按 tag 升序排列 —— 运行时会按 schema 顺序编码，顺序错了字节就对不上。
   *
   * `f2` 必须 `force`：`SsoMultiTerminalSync` 复用这个结构时 `f2 = 0`，
   * 不加 force 会被省略，字节就对不上抓包。
   */
  f('f2', 2, 'uint32', { force: true }),
  f('f3', 3, 'uint32', { force: true }),
  f('f4', 4, 'uint32', { force: true }),
  f('f7', 7, 'uint32', { force: true }),
  f('f8', 8, 'uint32'),
]);

/** `SsoInviteRoom` 请求。注意目标 uid 是 **repeated `f1`**。 */
export const GROUP_INVITE_ROOM_REQ: ProtoMessage = message([
  f('targets', 1, GROUP_INVITE_TARGET, { repeated: true }),
  f('f5', 5, 'uint32', { force: true }),
  f('f9', 9, 'uint32'),
  f('f11', 11, 'uint32'),
  f('f12', 12, 'uint32', { force: true }),
  f('f13', 13, GROUP_INVITE_MEDIA),
]);

/** `SsoInviteRoom` 回包：每个 uid 多一个 `f6=1`（已加入标记）。 */
export const GROUP_INVITE_ROOM_RSP: ProtoMessage = message([
  f(
    'targets',
    1,
    message([f('f1', 1, 'uint32'), f('f4', 4, 'string'), f('f6', 6, 'uint32', { force: true })]),
    { repeated: true },
  ),
]);

/**
 * `SsoQueryRoom` 请求。
 *
 * `wanted` 是一串 **`f2 = <条目类型>`**（repeated, 无子消息），问服务端要哪些
 * 信息。实测客户端发的固定是 `1,2,5,6,10,11,12,14,16`。
 *
 * `f4` 是 88 字节 authKey（**不在抓包里显式构造，直接从开房回包带过来**）。
 */
export const GROUP_QUERY_ROOM_REQ: ProtoMessage = message([
  /** 实测 = 0x28270853 = 673646675（与开房 `f8.f7`、邀请 `f13.f7` 同值）。 */
  f('roomId', 1, 'uint32', { force: true }),
  f('wanted', 2, 'uint32', { repeated: true, force: true }),
  f('f3', 3, 'uint32', { force: true }),
  /** 媒体块，与邀请的 `f13` 同构（authKey + f2/f3/f4/f7）。 */
  f(
    'media',
    4,
    message([
      f('authKey', 1, 'bytes'),
      f('f2', 2, 'uint32', { force: true }),
      f('f3', 3, 'uint32', { force: true }),
      f('f4', 4, 'uint32', { force: true }),
      f('f7', 7, 'uint32', { force: true }),
    ]),
  ),
  f('f5', 5, 'uint32', { force: true }),
]);

/** `SsoQueryRoom` 应答里的一个属性块。 */
export const GROUP_QUERY_ITEM: ProtoMessage = message([
  /** 属性类型：1 房间 / 2 成员 / 5 计数 / 6 成员数 / 10 uid / 11·12 掩码 / 14 计数 / 16 映射 */
  f('kind', 1, 'uint32', { force: true }),
  f('f2', 2, 'uint32'),
  f('members', 3, 'uint32', { repeated: true }),
  f('f4', 4, 'uint32', { force: true }),
  f('f5', 5, 'bytes'),
  f('uids', 6, 'string', { repeated: true }),
  f('f7', 7, 'bytes'),
  f('f8', 8, 'bytes'),
  f('f9', 9, 'uint32', { force: true }),
  /** kind=16 的映射表，每项 `{ f1: { f1: uin, f2: uid, f3: 2 } }`。 */
  f(
    'mappings',
    10,
    message([
      f(
        'f1',
        1,
        message([
          f('uin', 1, 'uint32', { force: true }),
          f('uid', 2, 'string'),
          f('f3', 3, 'uint32', { force: true }),
        ]),
      ),
    ]),
    { repeated: true },
  ),
  f('f11', 11, 'uint32', { force: true }),
]);

/** `SsoQueryRoom` 应答。 */
export const GROUP_QUERY_ROOM_RSP: ProtoMessage = message([
  f('items', 1, GROUP_QUERY_ITEM, { repeated: true }),
  f('f3', 3, 'uint32', { force: true }),
  f('f4', 4, 'bytes'),
  f('f5', 5, 'uint32'),
]);

/**
 * `SsoMultiTerminalSync` 请求。
 *
 * ```text
 * f1 = 15            常量
 * f2 = 1             常量
 * f3 = 10063         能力档（与开房 f3 同值）
 * f4 = <媒体块>      与邀请 `f13` 同构（authKey + f2=0 / f3=10 / f4=1 / f7=群号）
 * ```
 *
 * 抓包里这条请求只有 **111 字节**、到 `f4` 就结束，没有 `f5`。
 */
export const GROUP_MULTI_TERMINAL_REQ: ProtoMessage = message([
  f('f1', 1, 'uint32', { force: true }),
  f('f2', 2, 'uint32', { force: true }),
  f('f3', 3, 'uint32', { force: true }),
  f('f4', 4, GROUP_INVITE_MEDIA),
]);

// ─────────────────────────── 结果类型 ───────────────────────────

/** 群通话服务器条目。 */
export interface GroupServer {
  ip: string;
  port: number;
  /** `f4 = 1`：主 GCS。抓包里客户端连的就是这一组的第一条。 */
  primary: boolean;
  /** `f3 = 1`：备用组。 */
  backup: boolean;
}

/** 开房结果。 */
export interface GroupRoom {
  /**
   * 会话 ID。
   *
   * ⚠️ 回包 `f1.f2` 实测是**自己的 uin**，不是 roomId。真正的 roomId 在
   * `0x02`/`0x28` 包里用的是这个 uin 的低 32 位（实测 `0x65cc5249`）——
   * 也就是说 GCS 层面的「roomId」就等于主叫的 uin。
   * 这里保留 `f2` 原值，名字反映其真实含义。
   */
  ownerUin: number;
  /** 88 字节鉴权密钥。GCS head `f6` 与 `SsoQueryRoom` 的 `f4` 都用它。 */
  authKey: Uint8Array<ArrayBufferLike>;
  servers: GroupServer[];
}

/** 房间成员（`SsoQueryRoom` 归一化结果）。 */
export interface GroupRoomMember {
  /** 成员标识在 `0x19` / `0x64` / `0x73` 里就是它（4 字节大端）。 */
  uin: number;
  uid: string;
}

/** `SsoQueryRoom` 归一化结果。 */
export interface GroupRoomState {
  /** 群号（`SsoQueryRoom` 的 kind=1 / f2）。 */
  groupId: number | null;
  members: GroupRoomMember[];
}

// ─────────────────────────── 编码辅助 ───────────────────────────

/** 构造 `GROUP_USER`。 */
function userBlock(uid: string): { f1: number; f2: number; f4: string } {
  return { f1: 4, f2: 0, f4: uid };
}

/** 稳定的 uid → uin 反查（`SsoQueryRoom` 应答里拿）。 */
export function uidToUin(state: GroupRoomState, uid: string): number | null {
  return state.members.find((m) => m.uid === uid)?.uin ?? null;
}

/** uin → uid 反查。 */
export function uinToUid(state: GroupRoomState, uin: number): string | null {
  return state.members.find((m) => m.uin === uin)?.uid ?? null;
}

/**
 * 归一化 `SsoQueryRoom` 的应答。
 *
 * 只有 `kind = 16` 的块带**完整的 `uin ↔ uid` 映射**（`f10` 里每项是一个
 * `{ f1: { uin, uid, uidType } }`）；`kind = 10` 只有 uid 列表，单独出现时
 * 拿不到 uin，按「缺 uin 跳过」处理。
 */
export function normalizeQueryRoom(rsp: Record<string, unknown>): GroupRoomState {
  const items = (rsp.items ?? []) as Array<Record<string, unknown>>;
  let groupId: number | null = null;
  const byUin = new Map<number, string>();
  const byUid = new Map<string, number>();

  for (const item of items) {
    const kind = Number(item.kind ?? 0);
    if (kind === 1) {
      const f2 = Number(item.f2 ?? 0);
      if (f2) groupId = f2;
      continue;
    }
    if (kind !== 16) continue;
    const mappings = (item.mappings ?? []) as Array<Record<string, unknown>>;
    for (const mapping of mappings) {
      const inner = mapping.f1 as Record<string, unknown> | undefined;
      if (!inner) continue;
      const uin = Number(inner.uin ?? 0);
      const uid = String(inner.uid ?? '');
      if (!uin || !uid) continue;
      byUin.set(uin, uid);
      byUid.set(uid, uin);
    }
  }

  // 顺序按 uin 升序，保证调用方拿到的列表稳定（服务端顺序不保证）。
  const members: GroupRoomMember[] = [...byUin.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([uin, uid]) => ({ uin, uid }));
  return { groupId, members };
}

// ─────────────────────────── 命令 spec ───────────────────────────

/**
 * `SsoCreateRoom` —— 开一间群房间。
 *
 * 与私聊的关键差异：**没有 `peer` 字段**（私聊把对端 uid 塞在 `params.media.peer`）。
 * 群房间是空的，对端靠后续 `SsoInviteRoom` 拉进来。
 */
export const CreateGroupRoom: TrpcSpec<{ selfUid: string; groupId: number }, GroupRoom> = {
  cmd: GROUP_SSO_CMD.createRoom,
  /** 三份抓包离线核验：`reserved` 无 tag 24。 */
  needSign: false,
  reqSchema: GROUP_CREATE_ROOM_REQ,
  respSchema: GROUP_CREATE_ROOM_RSP,
  serialize: ({ selfUid, groupId }) => ({
    self: userBlock(selfUid),
    scene: GROUP_CALL_SCENE.audio,
    profile: GROUP_CAPABILITY_PROFILE,
    f4: CREATE_ROOM_F4,
    f5: CREATE_ROOM_F5,
    // f7 是**本次通话的群号**，必须由调用方传（抓包里的 673646675 只是那次通话的群）。
    f8: { ...CREATE_ROOM_F8_BASE, f7: groupId >>> 0 },
    f9: CREATE_ROOM_F9,
  }),
  deserialize: (body) => {
    const room = (body.room ?? {}) as Record<string, unknown>;
    // 回包 f6 是 9 条服务器：IPv6×3、IPv4×3、IPv4×3（备用）。
    // 标记位是 `f4`（主 GCS 为 1），`f3 = 1` 表示**备用**那一组 ——
    // 别把 f3 当成主标记，否则会把主服务器全判成 backup。
    const servers = ((body.servers ?? []) as Array<Record<string, unknown>>).map((s) => ({
      ip: String(s.ip ?? ''),
      port: Number(s.port ?? 0),
      primary: Number(s.f4 ?? 0) === 1,
      backup: Number(s.f3 ?? 0) === 1,
    }));
    return {
      ownerUin: Number(room.f2 ?? 0),
      authKey: (body.authKey as Uint8Array | undefined) ?? new Uint8Array(0),
      servers: servers.filter((s) => s.ip && s.port > 0),
    };
  },
};

/**
 * `SsoInviteRoom` —— 把一个或多个 uid 拉进房间。
 *
 * **可重复调用**：开房后立刻邀请、通话中途再邀请，用的是同一条命令、同一个结构
 * （③ 抓包 90.02s 的中途邀请与首次邀请逐字段同构）。
 */
export const InviteToGroupRoom: TrpcSpec<
  {
    targetUids: string[];
    authKey: Uint8Array;
    /** 本次通话的群号（`f13.f7`）。 */
    groupId: number;
    /** 时间戳（`f9`）。传 `Date.now()` 即可，服务端不校验。 */
    now?: number;
  },
  { invited: Array<{ uid: string; accepted: boolean }> }
> = {
  cmd: GROUP_SSO_CMD.inviteRoom,
  needSign: false,
  reqSchema: GROUP_INVITE_ROOM_REQ,
  respSchema: GROUP_INVITE_ROOM_RSP,
  serialize: ({ targetUids, authKey, groupId, now }) => {
    const ts = now ?? Date.now();
    // f9 抓包里是个 32 位固定值（66322442），f11 是秒级时间戳。
    // 两者都不参与服务端校验，但为了字节接近真实客户端，f9 用固定值。
    return {
      targets: targetUids.map(userBlock),
      f5: GROUP_INVITE_F5,
      f9: 66322442 >>> 0,
      f11: Math.floor(ts / 1000) >>> 0,
      f12: GROUP_CAPABILITY_PROFILE,
      f13: {
        authKey,
        // f2 是 32 位常量（实测 408356522 = 0x185206AA），与 f5 一起构成
        // 「媒体能力指纹」，三次抓包恒定，照抄即可。
        f2: GROUP_INVITE_MEDIA_F2,
        f3: 10,
        f4: 1,
        f7: groupId >>> 0,
        f8: 2,
      },
    };
  },
  deserialize: (body) => {
    const targets = (body.targets ?? []) as Array<Record<string, unknown>>;
    return {
      invited: targets.map((t) => ({
        uid: String(t.f4 ?? ''),
        // 回包里每个 uid 的 f6 恒为 1（已加入）。缺失按未加入处理。
        accepted: Number(t.f6 ?? 0) === 1,
      })),
    };
  },
};

/**
 * `SsoMultiTerminalSync` —— 让同账号的其它设备也响铃 / 同步房间状态。
 *
 * 抓包里在开房之后、邀请之前调一次；应答是**空 body**（0 字节），所以
 * `respSchema` 是空消息。
 */
export const MultiTerminalSync: TrpcSpec<{ authKey: Uint8Array; groupId: number }, void> = {
  cmd: GROUP_SSO_CMD.multiTerminalSync,
  needSign: false,
  reqSchema: GROUP_MULTI_TERMINAL_REQ,
  respSchema: message([]),
  serialize: ({ authKey, groupId }) => ({
    f1: MULTI_TERMINAL_F1,
    f2: MULTI_TERMINAL_F2,
    f3: GROUP_CAPABILITY_PROFILE,
    f4: {
      authKey,
      f2: 0,
      f3: 10,
      f4: 1,
      f7: groupId >>> 0,
    },
  }),
  deserialize: () => undefined,
};

/** `SsoQueryRoom` 默认要的条目类型（实测客户端固定这一串）。 */
/** 实测顺序就是 `1,2,6,5,10,11,12,14,16`（6 在 5 之前），不要重排。 */
export const QUERY_ROOM_WANTED = [1, 2, 6, 5, 10, 11, 12, 14, 16] as const;

/** `SsoQueryRoom` —— 查房间成员与状态。 */
export const QueryGroupRoom: TrpcSpec<{ groupId: number; authKey: Uint8Array }, GroupRoomState> = {
  cmd: GROUP_SSO_CMD.queryRoom,
  needSign: false,
  reqSchema: GROUP_QUERY_ROOM_REQ,
  respSchema: GROUP_QUERY_ROOM_RSP,
  serialize: ({ authKey, groupId }) => ({
    roomId: groupId,
    wanted: [...QUERY_ROOM_WANTED],
    f3: 2,
    media: {
      authKey,
      f2: GROUP_INVITE_MEDIA_F2,
      f3: 10,
      f4: 1,
      f7: groupId >>> 0,
    },
    f5: 8,
  }),
  deserialize: normalizeQueryRoom,
};

// ─────────────────────────── 便捷入口 ───────────────────────────

export type GroupCallSignalingNative = Parameters<typeof invokeTrpc>[0];

/**
 * 开房 + 邀请，一步完成。
 *
 * 两步之间失败时房间会泄漏在服务端（无副作用，到期自清），调用方拿到异常后
 * 不必自己回收。
 */
export async function startGroupCall(
  nt: GroupCallSignalingNative,
  pid: number,
  params: { selfUid: string; targetUids: string[]; groupId: number },
): Promise<{ room: GroupRoom; invited: Array<{ uid: string; accepted: boolean }> }> {
  if (params.targetUids.length === 0) throw new Error('至少需要一个邀请目标');
  if (!params.groupId) throw new Error('必须指定群号（群通话是按群开房间的）');
  const room = await invokeTrpc(nt, pid, CreateGroupRoom, {
    selfUid: params.selfUid,
    groupId: params.groupId,
  });
  const { invited } = await invokeTrpc(nt, pid, InviteToGroupRoom, {
    targetUids: params.targetUids,
    authKey: room.authKey,
    groupId: params.groupId,
  });
  return { room, invited };
}

/** 查一次房间。 */
export async function queryGroupRoom(
  nt: GroupCallSignalingNative,
  pid: number,
  params: { groupId: number; authKey: Uint8Array },
): Promise<GroupRoomState> {
  return invokeTrpc(nt, pid, QueryGroupRoom, params);
}

// ─────────────────────────── 测试辅助 ───────────────────────────

/** 单测用：编码开房请求。 */
export function encodeCreateGroupRoomReq(params: { selfUid: string; groupId: number }): Uint8Array {
  return encode(GROUP_CREATE_ROOM_REQ, CreateGroupRoom.serialize(params));
}

/** 单测用：编码邀请请求。 */
export function encodeInviteReq(params: {
  targetUids: string[];
  authKey: Uint8Array;
  groupId: number;
  now: number;
}): Uint8Array {
  return encode(GROUP_INVITE_ROOM_REQ, InviteToGroupRoom.serialize(params));
}

/** 单测用：编码查询请求。 */
export function encodeQueryReq(params: { groupId: number; authKey: Uint8Array }): Uint8Array {
  return encode(GROUP_QUERY_ROOM_REQ, QueryGroupRoom.serialize(params));
}

/** 单测用：从原始字节解一块 `SsoQueryRoom` 应答。 */
export function decodeQueryRoomRspBytes(bytes: Uint8Array): GroupRoomState {
  return normalizeQueryRoom(decodeQueryRoomRspRaw(bytes));
}

/** 从原始字节解 `SsoQueryRoom` 应答（不归一化）。 */
export function decodeQueryRoomRspRaw(bytes: Uint8Array): Record<string, unknown> {
  return decodeGroupRspBytes(GROUP_QUERY_ROOM_RSP, bytes);
}

// 延迟引入，避免与 protobuf 的循环依赖在类型层面出问题。
import { decode as decodeMsg } from '../protobuf';

function decodeGroupRspBytes(schema: ProtoMessage, bytes: Uint8Array): Record<string, unknown> {
  return decodeMsg(schema, bytes);
}

/**
 * 读 `SsoCreateRoom` 回包的原始字节。
 *
 * 回包里的字段全是 varint / length-delimited（**IP 是字符串**，不像私聊是
 * fixed32），所以不需要私聊那套「手工解 fixed32」的特殊路径。
 */
export function decodeCreateGroupRoomRspBytes(bytes: Uint8Array): GroupRoom {
  return CreateGroupRoom.deserialize(decodeGroupRspBytes(GROUP_CREATE_ROOM_RSP, bytes));
}

/** 把 pb 字段列表转成「字段号 → 值数组」，调试用。 */
export function groupFields(bytes: Uint8Array): Map<number, Array<number | Uint8Array>> {
  const out = new Map<number, Array<number | Uint8Array>>();
  for (const field of parsePb(bytes)) {
    const list = out.get(field.field) ?? [];
    list.push(field.bytes ?? Number(field.value ?? 0));
    out.set(field.field, list);
  }
  return out;
}

// 供测试/调用方拼自定义 body 用（保持与 `call/gcs.ts` 同一套工具）。
export { pbBytes, pbVarint };
