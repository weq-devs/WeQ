/**
 * 群通话的 `0x02` 通道（全部媒体 + 控制面）。
 *
 * **这是群聊与私聊最大的结构差异**：私聊的音频/视频走 `0x5b`，`0x02` 只是中继
 * 注册与 P2P 打洞的补充路径；群聊**没有 P2P**，所有东西都塞在 `0x02` 里，靠
 * `[7:9]` 的命令号分流。
 *
 * 三份抓包（2026-11-05）里出现过的全部命令（第二轮逐包复核后的版本）：
 *
 * ```text
 * 0x11 c2s  自己离开（未收到 0x12 前每 ~100ms 重发）      （③ 1 次 / ② 5 次）
 * 0x12 s2c  对 0x11 的应答                              （③ 1 次）
 * 0x13 c2s  订阅成员流（带当前密钥 + 成员表）              （②③ 各 4 次）
 * 0x14 s2c  对 0x13 的应答                              （②③ 各 4 次）
 * 0x17 c2s  上行媒体                                    （①②③ 大量）
 * 0x18 s2c  下行媒体（每成员一路）                        （①②③ 大量）
 * 0x19 s2c  成员状态变化 ★                               （①②③）
 * 0x1a c2s  对 0x19 的应答                               （①②③）
 * 0x25 c2s  通道认证（带 88B 会话密钥）                    （②③）
 * 0x26 s2c  认证回包                                     （②③）
 * 0x2d s2c  保活（2 秒一次）                              （①②③）
 * 0x2e c2s  保活应答                                     （①②③）
 * 0x64 s2c  摄像头状态推送                                （②③）
 * 0x65 c2s  对 0x64 的应答                               （②③）
 * 0x73 c2s  麦克风开关 / 静音别人 ★                       （③）
 * 0x74 s2c  对 0x73 的应答                               （③）
 * ```
 *
 * ⚠️ **没有 `0x7f`**。旧实现把「自己退出」写成 `0x7f`，三份抓包里一次都没出现过，
 * 退出其实是 `0x11` + `0x12` 应答。
 *
 * 包格式（与私聊的 39 字节 relay 头**完全不同**）：
 *
 * ```text
 * [0]      0x02
 * [1:3]    len (2BE)，= UDP 载荷长度
 * [3]      kind（通道类型，随命令变：控制面 0x00、媒体/事件 0x04 / 0x03、
 *          保活 0x24 / 0x5f；应答大多回填收到那条的 kind）
 * [4:7]    route（3B，本端逐包递增；应答多半回填收到的 route）
 * [7:9]    cmd (2BE)
 * [9:13]   恒 0
 * [13:17]  **流归属成员 uin**：c2s 全是自己，`0x18` 是发流那个成员
 * [17:]    body，各命令都以 7 字节流标识开头
 * [-1]     0x03（结束符）
 * ```
 *
 * **流标识不能硬编码**：每通电话、每个成员都不一样（③ 自己 `18 57 06 aa 67 7e 00`、
 * ② 自己 `18 b6 06 aa 47 32 00`；`0x19`/`0x2d` 里则是 `... 00 01 00` 形态）。
 * 所以本模块所有构造函数都要求调用方显式传入 `stream`。
 *
 * 本模块只做**编解码**，不含定时器与套接字；状态机见
 * `@weq/service` 的 `account/group_call_session.ts`。
 */

import { u16be, u32be, writeU32be } from '../call/gcs';
import { GROUP_SESSION_KEY_LEN } from './gcs';

// ─────────────────────────── 常量 ───────────────────────────

/** `0x02` 的起始字节。 */
export const GROUP_RELAY_STX = 0x02;
/** 结束符。 */
export const GROUP_RELAY_ETX = 0x03;
/** 固定前缀长度：body 从 `[17]` 开始（到 `[13:17]` 的流归属 uin 为止）。 */
export const GROUP_RELAY_PREFIX_LEN = 17;
/** 流标识长度（每条消息 body 开头）。 */
export const GROUP_STREAM_LEN = 7;
/** `0x73` / `0x13` / `0x11` 里「密钥块」的固定前缀：`stream | 01 58 | key`。 */
const KEY_BLOCK_HEADER_LEN = GROUP_STREAM_LEN + 2;

/** 群通话 `0x02` 的命令号。 */
export const GroupRelayCmd = {
  /** 自己离开（c2s）。别人离开走 `0x19`。 */
  exit: 0x11,
  exitAck: 0x12,
  /** 订阅成员流（c2s，带当前密钥 + 成员表）。 */
  streamSubscribe: 0x13,
  streamSubscribeAck: 0x14,
  /** 上行媒体（音频 / 视频）。 */
  mediaUp: 0x17,
  /** 下行媒体（每成员一路）。 */
  mediaDown: 0x18,
  /** 成员状态变化。 */
  memberState: 0x19,
  memberStateAck: 0x1a,
  /** 通道认证。 */
  auth: 0x25,
  authRsp: 0x26,
  /** 保活（s2c，2 秒一次）。 */
  keepalive: 0x2d,
  keepaliveAck: 0x2e,
  /** 摄像头状态推送（s2c）。 */
  cameraState: 0x64,
  cameraStateAck: 0x65,
  /** 麦克风开关 / 静音别人（c2s）。 */
  micState: 0x73,
  micStateAck: 0x74,
} as const;

/** 命令号的调试名。 */
export function groupRelayCmdName(cmd: number): string {
  for (const [name, value] of Object.entries(GroupRelayCmd)) {
    if (value === cmd) return name;
  }
  return `0x${cmd.toString(16)}`;
}

// ─────────────────────────── 包头 ───────────────────────────

/** 解析后的 `0x02` 包。 */
export interface GroupRelayPacket {
  /** `[3]`：通道类型（随命令变，应答多半回填）。 */
  kind: number;
  /** `[4:7]`：3 字节路由（每包递增）。 */
  route: number;
  cmd: number;
  /** `[13:17]`：流归属成员 uin（c2s 恒为自己）。 */
  ownerUin: number;
  /** body 开头的 7 字节流标识；不是流包（如应答）时为 null。 */
  stream: Uint8Array | null;
  /** `[17:]` 到结束符之间的字节。 */
  body: Uint8Array;
  /** 完整原始载荷。 */
  raw: Uint8Array;
}

export function parseGroupRelay(data: Uint8Array): GroupRelayPacket | null {
  if (data.length < GROUP_RELAY_PREFIX_LEN + 2 || data[0] !== GROUP_RELAY_STX) return null;
  const kind = data[3]!;
  const route = (data[4]! << 16) | (data[5]! << 8) | data[6]!;
  const cmd = u16be(data, 7);
  const ownerUin = u32be(data, 13);
  const end = data[data.length - 1] === GROUP_RELAY_ETX ? data.length - 1 : data.length;
  const body = data.subarray(GROUP_RELAY_PREFIX_LEN, end);
  const stream =
    body.length >= GROUP_STREAM_LEN && u32be(body, 0) !== 0
      ? body.subarray(0, GROUP_STREAM_LEN)
      : null;
  return { kind, route, cmd, ownerUin, stream, body, raw: data };
}

/** 组一个 `0x02` 包（`route` 由调用方维护递增）。 */
export function buildGroupRelay(params: {
  cmd: number;
  route: number;
  /** `[13:17]`：发这条消息的成员 uin（自己发就填自己）。 */
  ownerUin: number;
  /** `[3]`：通道类型；默认 0x00（控制面）。 */
  kind?: number;
  body: Uint8Array;
}): Uint8Array {
  const total = GROUP_RELAY_PREFIX_LEN + params.body.length + 1;
  if (total > 0xffff) throw new RangeError(`群通话包超过 65535 字节：${total}`);
  const out = new Uint8Array(total);
  out[0] = GROUP_RELAY_STX;
  out[1] = (total >>> 8) & 0xff;
  out[2] = total & 0xff;
  out[3] = params.kind ?? 0x00;
  out[4] = (params.route >>> 16) & 0xff;
  out[5] = (params.route >>> 8) & 0xff;
  out[6] = params.route & 0xff;
  out[7] = (params.cmd >>> 8) & 0xff;
  out[8] = params.cmd & 0xff;
  // [9:13] 恒 0
  writeU32be(out, 13, params.ownerUin);
  out.set(params.body, GROUP_RELAY_PREFIX_LEN);
  out[out.length - 1] = GROUP_RELAY_ETX;
  return out;
}

// ─────────────────────────── 成员状态（0x19） ───────────────────────────

/** `0x19` 的事件类型（body[11]）。 */
export const GroupMemberEvent = {
  /** 成员进入。 */
  join: 0x01,
  /** 成员离开 / 流关闭（自己退出那一刻也是它）。 */
  leave: 0x02,
  /** 媒体 / 静音状态更新。 */
  update: 0x03,
} as const;

/**
 * `0x19` 解析结果。
 *
 * 字段偏移来自 2026-11-05 的逐包比对（②③ 共 23 条事件全部对上）：
 *
 * ```text
 * body[0:7]    流标识（`18 57 06 aa 00 01 4a`）
 * body[7:10]   事件序号（3B 递增，0x24cbf4 → 0x24cc00）
 * body[10]     0x00
 * body[11]     事件类型：01 进入 / 02 离开 / 03 更新
 * body[12:16]  0x03 00 00 00（旧位置误标过「事件类型」，其实是常量）
 * body[16:20]  uin（4B 大端）
 * body[20]     媒体状态：0x01 = 有视频，0x02 = 无
 * body[21]     角色/终端：0x0f = 自己，0x05 = 别人（语义待定）
 * body[22]     0x00
 * body[23]     静音：0x01 = 静音，0x00 = 未静音
 * ```
 */
export interface GroupMemberState {
  /** 成员的 uin（4B 大端）。 */
  uin: number;
  /** 媒体轨是否活跃（`body[20] === 0x01`）。 */
  video: boolean;
  /** 是否为「自己」（`body[21] === 0x0f`）。 */
  self: boolean;
  /** `body[21]` 原值（0x0f / 0x05）。 */
  role: number;
  /** 是否被静音（`body[23] === 0x01`）。 */
  muted: boolean;
  /** 事件类型，见 {@link GroupMemberEvent}。 */
  event: number;
  /** 事件序号（`body[7:10]`，3B 大端）。 */
  seq: number;
  /** body 开头的 7 字节流标识。 */
  stream: Uint8Array;
  /** 完整 body，调试用。 */
  raw: Uint8Array;
}

export function parseGroupMemberState(body: Uint8Array): GroupMemberState | null {
  if (body.length < 24) return null;
  const uin = u32be(body, 16);
  if (uin === 0) return null;
  return {
    uin,
    video: body[20] === 0x01,
    self: body[21] === 0x0f,
    role: body[21]!,
    muted: body[23] === 0x01,
    event: body[11]!,
    seq: ((body[7]! << 16) | (body[8]! << 8) | body[9]!) >>> 0,
    stream: body.subarray(0, GROUP_STREAM_LEN),
    raw: body,
  };
}

// ─────────────────────────── 摄像头（0x64） ───────────────────────────

/** `0x64` 解析结果。 */
export interface GroupCameraState {
  /** 操作者的 uin。 */
  uin: number;
  /** true = 摄像头开。 */
  on: boolean;
  raw: Uint8Array;
}

/**
 * 解析 `0x64`（摄像头状态推送，body 30B）。
 *
 * ```text
 * body[0:7]   流标识（`18 57 06 aa 00 0c 00`）
 * body[8]     0x14
 * body[12:16] 操作者 uin
 * body[18]    开关位：0x08 = 开，0x00 = 关
 * ```
 */
export function parseGroupCameraState(body: Uint8Array): GroupCameraState | null {
  if (body.length < 19) return null;
  const uin = u32be(body, 12);
  if (uin === 0) return null;
  return { uin, on: body[18] === 0x08, raw: body };
}

// ─────────────────────────── 麦克风（0x73） ───────────────────────────

/**
 * `0x73` 解析结果。
 *
 * 结构（③ 三次实测）：
 *
 * ```text
 * stream(7) | 01 58 | <当前会话密钥 88B> | 00 |
 *   13 00 05 <静音位> 00000000                              —— 操作自己
 *   11 00 0d 00000000 <目标 uin 4B> 01 00000000              —— 静音别人
 * ```
 *
 * - 目标 uin 为空 → 操作自己；有值 → **静音别人**（群通话独有的管理能力）。
 * - 静音位 `0x01` = 静音，`0x00` = 取消。
 *
 * ⚠️ 不能靠「找结尾 `94`」定位：那段 88 字节是**会话密钥**，③ 的密钥恰好以
 * `94` 结尾，② 的以 `bf` 结尾，按固定偏移读才稳。
 */
export interface GroupMicState {
  /** 被操作者；null 表示操作自己。 */
  targetUin: number | null;
  muted: boolean;
  /** 报文里带的会话密钥（88B），可用于核对「是不是用当前密钥发的」。 */
  key: Uint8Array;
  raw: Uint8Array;
}

/** `0x73` / `0x13` 里「密钥之后那个 `00` 再往后」的 tag/count 字节下标。 */
const MIC_TAIL_OFFSET = KEY_BLOCK_HEADER_LEN + GROUP_SESSION_KEY_LEN + 1;
/** `0x73` 带目标时：tag 后第 7 个字节是目标 uin。 */
const MIC_TARGET_UIN_OFFSET = MIC_TAIL_OFFSET + 7;

export function parseGroupMicState(body: Uint8Array): GroupMicState | null {
  if (body.length < MIC_TAIL_OFFSET + 2) return null;
  if (body[GROUP_STREAM_LEN] !== 0x01 || body[GROUP_STREAM_LEN + 1] !== 0x58) return null;
  const key = body.subarray(KEY_BLOCK_HEADER_LEN, KEY_BLOCK_HEADER_LEN + GROUP_SESSION_KEY_LEN);
  const tag = body[MIC_TAIL_OFFSET]!;
  if (tag === 0x13) {
    // 00 | 13 00 05 <静音位> 00000000
    if (body.length < MIC_TAIL_OFFSET + 4) return null;
    return { targetUin: null, muted: body[MIC_TAIL_OFFSET + 3] === 0x01, key, raw: body };
  }
  if (tag === 0x11) {
    // 00 | 11 00 0d 00000000 <uin 4B> 01 00000000
    if (body.length < MIC_TARGET_UIN_OFFSET + 4) return null;
    const uin = u32be(body, MIC_TARGET_UIN_OFFSET);
    return { targetUin: uin === 0 ? null : uin, muted: true, key, raw: body };
  }
  return null;
}

/** 组一个 `0x73`（自己的麦克风开关 / 静音别人）。 */
export function buildGroupMicState(params: {
  route: number;
  ownerUin: number;
  /** 本端 7 字节流标识。 */
  stream: Uint8Array;
  /** 当前会话密钥（k2；还没下发时用 k1）。 */
  key: Uint8Array;
  muted: boolean;
  /** 目标 uin；省略表示操作自己。 */
  targetUin?: number;
}): Uint8Array {
  assertStream(params.stream);
  assertKey(params.key);
  const hasTarget = params.targetUin !== undefined && params.targetUin !== 0;
  const tail = hasTarget
    ? [
        0x00,
        0x11,
        0x00,
        0x0d,
        0x00,
        0x00,
        0x00,
        0x00, //
        (params.targetUin! >>> 24) & 0xff,
        (params.targetUin! >>> 16) & 0xff,
        (params.targetUin! >>> 8) & 0xff,
        params.targetUin! & 0xff,
        0x01,
        0x00,
        0x00,
        0x00,
        0x00,
      ]
    : [0x00, 0x13, 0x00, 0x05, params.muted ? 0x01 : 0x00, 0x00, 0x00, 0x00, 0x00];
  const body = concat([keyBlock(params.stream, params.key), Uint8Array.from(tail)]);
  return buildGroupRelay({
    route: params.route,
    cmd: GroupRelayCmd.micState,
    ownerUin: params.ownerUin,
    body,
  });
}

// ─────────────────────────── 认证 / 保活 / 订阅 ───────────────────────────

/**
 * 通道认证（`0x25`）。
 *
 * ```text
 * stream(7) | 01 58 | <88B 会话密钥> | 03 00 00 00 00
 * ```
 *
 * 第一次认证用开房回包的 authKey（k1）；k2 下发后如果再认证（成员流变化时会
 * 重发），要换成 k2。
 */
export function buildGroupAuth(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  key: Uint8Array;
}): Uint8Array {
  assertStream(params.stream);
  assertKey(params.key);
  const body = concat([
    keyBlock(params.stream, params.key),
    Uint8Array.from([0x03, 0x00, 0x00, 0x00, 0x00]),
  ]);
  return buildGroupRelay({
    route: params.route,
    cmd: GroupRelayCmd.auth,
    ownerUin: params.ownerUin,
    body,
  });
}

/** 认证回包（`0x26`）。 */
export interface GroupAuthResult {
  /** 没有错误文本即视为认证通过（`Repeat request 3` 也算通过，它是幂等提示）。 */
  ok: boolean;
  /** 服务端附带的提示，如 `Repeat request 3`；成功时为空串。 */
  message: string;
  /** 尾部状态码（实测成功与 Repeat 都是 3）。 */
  code: number;
  raw: Uint8Array;
}

/**
 * 解析 `0x26`。
 *
 * ```text
 * 成功   14B：00×9 | 03 | 00000000
 * 重复   30B：00×5 | 10 | "Repeat request 3" | 00 00 00 | 03 | 00000000
 * ```
 *
 * 即：`body[5]` 是错误文本长度，文本从 `body[6]` 起，文本之后第 4 个字节是状态码。
 */
export function parseGroupAuthRsp(body: Uint8Array): GroupAuthResult {
  const len = body.length > 5 ? body[5]! : 0;
  const code = body.length > 6 + len + 3 ? body[6 + len + 3]! : 0;
  if (len < 0x04 || 6 + len > body.length) return { ok: true, message: '', code, raw: body };
  const text = body.subarray(6, 6 + len);
  if (!text.every((b) => b >= 0x20 && b < 0x7f)) return { ok: true, message: '', code, raw: body };
  const msg = String.fromCharCode(...text);
  return { ok: msg.startsWith('Repeat'), message: msg, code, raw: body };
}

/**
 * 保活（`0x2d`，s2c，2 秒一次）。本端要回 `0x2e`。
 *
 * ```text
 * stream(7) | 00 00 00 | <房间归属 uin 4B> | 10×00
 * ```
 */
export function parseGroupKeepalive(body: Uint8Array): { roomUin: number } | null {
  if (body.length < 14) return null;
  return { roomUin: u32be(body, 10) };
}

/**
 * 订阅成员流（`0x13`）。
 *
 * ```text
 * stream(7) | 01 58 | <88B 当前密钥> | 00 | <成员数 1B> | 000000
 *   + 每成员 17B：uin(4) | 01 0e 01 e0 | 9×00
 * ```
 *
 * 成员表以 `0x03` 收尾：有成员时落在**最后一个成员项的第 17 字节**，成员表为空时
 * 落在 6 字节头的最后一字节（抓包 `... 00 00 | 00 | 00 00 00 03 | 03`）。
 *
 * ③ 里每收到一次远端成员状态（`0x19` type=01/03/02）就会跟一条 `0x13`，紧接着服务端回
 * `0x14`；成员表清空时（自己退出前）发一条 0 成员的。
 */
export function buildGroupStreamSubscribe(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  key: Uint8Array;
  memberUins: number[];
}): Uint8Array {
  assertStream(params.stream);
  assertKey(params.key);
  if (params.memberUins.length > 0xff) throw new RangeError('成员数超过 255');
  const empty = params.memberUins.length === 0;
  const parts: Uint8Array[] = [
    keyBlock(params.stream, params.key),
    // 6 字节头：00 | count | 000000。空成员表时结束标记 `0x03` 就落在这里。
    Uint8Array.from([0x00, params.memberUins.length, 0x00, 0x00, 0x00, empty ? 0x03 : 0x00]),
  ];
  for (const [index, uin] of params.memberUins.entries()) {
    const entry = new Uint8Array(17);
    writeU32be(entry, 0, uin);
    entry[4] = 0x01;
    entry[5] = 0x0e;
    entry[6] = 0x01;
    entry[7] = 0xe0;
    // 成员表以 `0x03` 收尾（跟协议里的结束符同一个值），中间项是 0x00。
    entry[16] = index === params.memberUins.length - 1 ? 0x03 : 0x00;
    parts.push(entry);
  }
  return buildGroupRelay({
    route: params.route,
    cmd: GroupRelayCmd.streamSubscribe,
    ownerUin: params.ownerUin,
    body: concat(parts),
  });
}

/** `0x13` 解析结果。 */
export interface GroupStreamSubscribe {
  memberUins: number[];
  key: Uint8Array;
  raw: Uint8Array;
}

export function parseGroupStreamSubscribe(body: Uint8Array): GroupStreamSubscribe | null {
  if (body.length < MIC_TAIL_OFFSET + 2) return null;
  if (body[GROUP_STREAM_LEN] !== 0x01 || body[GROUP_STREAM_LEN + 1] !== 0x58) return null;
  const key = body.subarray(KEY_BLOCK_HEADER_LEN, KEY_BLOCK_HEADER_LEN + GROUP_SESSION_KEY_LEN);
  const countAt = MIC_TAIL_OFFSET;
  const count = body[countAt]!;
  const memberUins: number[] = [];
  let off = countAt + 5;
  for (let i = 0; i < count; i++) {
    if (off + 4 > body.length) return null;
    memberUins.push(u32be(body, off));
    off += 17;
  }
  return { memberUins, key, raw: body };
}

// ─────────────────────────── 应答（0x1a / 0x2e / 0x65 / 0x74） ───────────────────────────

/**
 * 通用应答（`0x1a`、`0x2e`、`0x65`、`0x74` 同构，body 恒 16B）：
 *
 * ```text
 * stream(7) | 01 00 00 00 | 01 00 00 00 00
 * ```
 *
 * `stream` 用的是**本端**的流标识（不是收到那条的），抓包里 `0x2d` 的流是
 * `... 00 01 00`、应答却回到 `... 67 7e 00`。
 */
export function buildGroupAck(params: {
  cmd: number;
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  /** `[3]`；抓包里多数回填收到那条的 kind。 */
  kind?: number;
}): Uint8Array {
  assertStream(params.stream);
  const body = new Uint8Array(16);
  body.set(params.stream, 0);
  body[7] = 0x01;
  body[11] = 0x01;
  return buildGroupRelay({
    route: params.route,
    cmd: params.cmd,
    ownerUin: params.ownerUin,
    kind: params.kind,
    body,
  });
}

/** 保活应答（`0x2e`）。 */
export function buildGroupKeepaliveAck(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  kind?: number;
}): Uint8Array {
  return buildGroupAck({ ...params, cmd: GroupRelayCmd.keepaliveAck });
}

/** 成员状态应答（`0x1a`）。 */
export function buildGroupMemberStateAck(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  kind?: number;
}): Uint8Array {
  return buildGroupAck({ ...params, cmd: GroupRelayCmd.memberStateAck });
}

// ─────────────────────────── 退出（0x11） ───────────────────────────

/**
 * 自己离开（`0x11`）。
 *
 * ```text
 * stream(7) | 01 58 | <88B 当前密钥> | 8×00
 * ```
 *
 * 服务端回 `0x12`（10 个 0）。② 里客户端连发 5 次（每 ~100ms）直到收到应答，
 * 所以会话层要做重发。
 */
export function buildGroupExit(params: {
  route: number;
  ownerUin: number;
  stream: Uint8Array;
  key: Uint8Array;
}): Uint8Array {
  assertStream(params.stream);
  assertKey(params.key);
  const body = concat([keyBlock(params.stream, params.key), new Uint8Array(8)]);
  return buildGroupRelay({
    route: params.route,
    cmd: GroupRelayCmd.exit,
    ownerUin: params.ownerUin,
    body,
  });
}

// ─────────────────────────── 小工具 ───────────────────────────

/** `stream | 01 58 | key` 这段公共前缀。 */
function keyBlock(stream: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(KEY_BLOCK_HEADER_LEN + key.length);
  out.set(stream, 0);
  out[GROUP_STREAM_LEN] = 0x01;
  out[GROUP_STREAM_LEN + 1] = 0x58;
  out.set(key, KEY_BLOCK_HEADER_LEN);
  return out;
}

function assertStream(stream: Uint8Array): void {
  if (stream.length !== GROUP_STREAM_LEN) {
    throw new RangeError(`流标识必须是 ${GROUP_STREAM_LEN} 字节，收到 ${stream.length}`);
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== GROUP_SESSION_KEY_LEN) {
    throw new RangeError(`会话密钥必须是 ${GROUP_SESSION_KEY_LEN} 字节，收到 ${key.length}`);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const part of parts) {
    out.set(part, off);
    off += part.length;
  }
  return out;
}
