/**
 * 通话的 UDP 三层包格式：GCS（控制面）/ Relay（中继）/ Audio（媒体）。
 *
 * 这三层都在同一条 UDP 套接字上收发，靠首字节区分：
 *
 *   `0x28` GCS   —— 认证、心跳、房间事件、质量上报、登出
 *   `0x02` Relay —— 中继通道注册与保活
 *   `0x5b` Audio —— Opus 音频帧、FEC 控制包、质量反馈
 *
 * 本模块只负责**编解码**，不含套接字与定时器（那是 `call/session.ts` 的事），
 * 也不依赖 Node 的 `Buffer` —— 全程 `Uint8Array` + `DataView`，这样协议层
 * 在渲染进程、测试环境里都能直接跑。
 */

// ─────────────────────────── 小工具 ───────────────────────────

const VIEW = new DataView(new ArrayBuffer(8));

function u32be(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}
function u16be(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 8) | buf[off + 1]!) >>> 0;
}
function _u64be(buf: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(buf[off + i]!);
  return v;
}

function writeU32be(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 24) & 0xff;
  buf[off + 1] = (value >>> 16) & 0xff;
  buf[off + 2] = (value >>> 8) & 0xff;
  buf[off + 3] = value & 0xff;
}
function writeU16be(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 8) & 0xff;
  buf[off + 1] = value & 0xff;
}
function writeU64be(buf: Uint8Array, off: number, value: bigint): void {
  let v = value;
  for (let i = 7; i >= 0; i--) {
    buf[off + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
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

// ─────────────────────────── protobuf 最小写入/读取 ───────────────────────────

/** 无符号 varint。通话协议里没有负数，不必处理补码。 */
export function encodeVarint(value: number | bigint): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(Math.max(0, Math.trunc(value)));
  const bytes: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return new Uint8Array(bytes);
}

function tag(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

/** 字段写入：varint。 */
export function pbVarint(field: number, value: number | bigint): Uint8Array {
  return concat([tag(field, 0), encodeVarint(value)]);
}

/** 字段写入：length-delimited。 */
export function pbBytes(field: number, data: Uint8Array): Uint8Array {
  return concat([tag(field, 2), encodeVarint(data.length), data]);
}

/** 字段写入：fixed32（小端，protobuf 规定）。 */
export function pbFixed32(field: number, value: number): Uint8Array {
  const out = new Uint8Array(5);
  out.set(tag(field, 5), 0);
  VIEW.setUint32(0, value >>> 0, true);
  out[1] = VIEW.getUint8(0);
  out[2] = VIEW.getUint8(1);
  out[3] = VIEW.getUint8(2);
  out[4] = VIEW.getUint8(3);
  return out;
}

export interface PbField {
  field: number;
  wire: number;
  /** wire=0 时的值。 */
  value?: bigint;
  /** wire=2 时的载荷。 */
  bytes?: Uint8Array;
  /** wire=5 时的值。 */
  fixed32?: number;
}

/**
 * 平铺解析一层 protobuf。
 *
 * 只做「字段 → 值」的浅层展开，不递归（调用方需要嵌套时对自己拿到的 bytes
 * 再调一次）。通话协议里需要递归的只有房间事件那一处。
 */
export function parsePb(buf: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let i = 0;
  while (i < buf.length) {
    const [rawTag, n1] = readVarint(buf, i);
    if (rawTag === null) break;
    i = n1;
    const field = Number(rawTag >> 3n);
    const wire = Number(rawTag & 7n);
    if (field === 0) break;
    if (wire === 0) {
      const [v, n2] = readVarint(buf, i);
      if (v === null) break;
      out.push({ field, wire, value: v });
      i = n2;
    } else if (wire === 2) {
      const [len, n2] = readVarint(buf, i);
      if (len === null) break;
      const start = n2;
      const end = start + Number(len);
      if (end > buf.length) break;
      out.push({ field, wire, bytes: buf.subarray(start, end) });
      i = end;
    } else if (wire === 5) {
      if (i + 4 > buf.length) break;
      out.push({ field, wire, fixed32: u32be(buf, i) });
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else {
      break;
    }
  }
  return out;
}

/** 读 varint；越界返回 `[null, i]`。 */
export function readVarint(buf: Uint8Array, start: number): [bigint | null, number] {
  let value = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++]!;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [value, i];
    shift += 7n;
    if (shift > 63n) return [null, i];
  }
  return [null, i];
}

/** 取第一个 varint 字段。 */
export function pbGetVarint(buf: Uint8Array, field: number): number | undefined {
  const f = parsePb(buf).find((x) => x.field === field && x.wire === 0);
  return f?.value === undefined ? undefined : Number(f.value);
}

/** 取第一个 length-delimited 字段。 */
export function pbGetBytes(buf: Uint8Array, field: number): Uint8Array | undefined {
  return parsePb(buf).find((x) => x.field === field && x.wire === 2)?.bytes;
}

// ═══════════════════════════ GCS (0x28) ═══════════════════════════

export const GCS_STX = 0x28;
export const GCS_ETX = 0x29;

/** `head.bodyType` 的取值。 */
export const GcsBodyType = {
  authReq: 1,
  authRsp: 2,
  /** 房间事件推送（对端进入 / 接听 / 挂断 / 超时…）。 */
  notifyPush: 3,
  notifyAck: 4,
  ctrlPush: 9,
  ctrlAck: 10,
  configPush: 11,
  configAck: 12,
  statusReport: 15,
  statusReportAck: 16,
  heartbeat: 23,
  heartbeatAck: 24,
  peerJoin: 27,
  peerJoinAck: 28,
  mediaCtrlPush: 75,
  mediaCtrlAck: 76,
  logout: 1003,
} as const;

/** `head.typeId` 的初始值。心跳与状态上报在此基础上递增。 */
export const GCS_TYPE_ID_BASE = 0x1959;

/** 建 GCS head。 */
export interface GcsHeadFields {
  roomId: bigint;
  selfUin: number;
  /** 认证前为 0，认证后填回包里的会话时间戳。 */
  sessionTs: number;
  typeId: number;
  /** 只有 auth（bt=1）与媒体控制 ACK（bt=76）需要带。 */
  authKey?: Uint8Array;
  bodyType: number;
  errorCode?: number;
}

export function buildGcsHead(head: GcsHeadFields): Uint8Array {
  const parts = [
    pbVarint(1, head.roomId),
    pbVarint(2, head.selfUin),
    pbVarint(3, head.sessionTs),
    pbVarint(4, head.typeId),
  ];
  if (head.authKey && head.authKey.length > 0) parts.push(pbBytes(5, head.authKey));
  parts.push(pbVarint(6, head.bodyType));
  parts.push(pbVarint(7, head.errorCode ?? 0));
  return concat(parts);
}

/** 包成 `28 | headLen(4) | bodyLen(4) | head | body | 29`。 */
export function buildGcsPacket(head: Uint8Array, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(10 + head.length + body.length);
  out[0] = GCS_STX;
  writeU32be(out, 1, head.length);
  writeU32be(out, 5, body.length);
  out.set(head, 9);
  out.set(body, 9 + head.length);
  out[out.length - 1] = GCS_ETX;
  return out;
}

/** 解析后的 GCS 包。 */
export interface GcsPacket {
  bodyType: number;
  typeId: number;
  /** `head` 里的会话时间戳（认证回包里有值）。 */
  sessionTs: number;
  head: Uint8Array;
  body: Uint8Array;
}

export function parseGcsPacket(data: Uint8Array): GcsPacket | null {
  if (data.length < 11 || data[0] !== GCS_STX) return null;
  const headLen = u32be(data, 1);
  const bodyLen = u32be(data, 5);
  const total = 10 + headLen + bodyLen;
  if (data.length < total) return null;
  const head = data.subarray(9, 9 + headLen);
  const body = data.subarray(9 + headLen, 9 + headLen + bodyLen);
  return {
    bodyType: pbGetVarint(head, 6) ?? 0,
    typeId: pbGetVarint(head, 4) ?? 0,
    sessionTs: pbGetVarint(head, 3) ?? 0,
    head,
    body,
  };
}

/**
 * 认证能力集。
 *
 * 一段固定的媒体能力协商描述：10 组编码能力 + 音频 / 视频 / 网络配置，描述
 * 「本端能解哪些编码、带宽多少、要不要回声消除」。服务端拿它给房间选路，
 * 内容不必逐字段构造 —— 但**必须存在且能解析**，空 body 会被直接断开。
 */
export const DEFAULT_CAPABILITIES: Uint8Array = Uint8Array.from(
  atob(
    'CtoDChkIAhABGOADIIAFKBQwgAg4wLsBQAFIAFABChkIAhACGOADIIAFKBQwgAg4wLsBQAFIAFABChkIAxABGLAJIIAPKA8wgCg42J4IQAFIAFABChkIAxACGLAJIIAPKB4wgCg4sL0QQAFIAFABChkIBBABGLAJIIAPKA8wgCg42J4IQAFIAFABChkIBBACGLAJIIAPKB4wgCg4sL0QQAFIAFABChkIBRABGLAJIIAPKA8wgCg42J4IQAFIAFABChkIBRACGLAJIIAPKB4wgCg4sL0QQAFIAFABChsIBhABGOADIIAFKA8wgCg40L2roAtAAUgAUAEKGwgGEAIY4AMggAUoDzCAKDi4vqugC0ABSABQAQoACgAKAAoACgAKAAoACgASXQgAEAAYACJSh2VDIQACACkDIA+gC7gAfgDAACsCWA+gBdwAfgDAAEAJYAyACWAAfgDAAEEJYBkACWAAfgDAAEIJYBkACWAAfgDAAFADIA+gC7gAfgDAEjRWeCoBABogCghTaGFycENhbRIICOADEOgCGB4SCAiABRDgAxgeGAEiFQi4FxABGAYgACgAMABKAnBjWgJwYyiAFDCgC0ABSAFQAFgCaAFwAXgBgAEBiAEHmAECqAEBEAEYBShkMMpOOAFAAUoAWMDR5gxqBAgDEAJyBggAEAAYAIIBVwoiMTAwMTNfYXVkaW9fY29uZmlnXzEwMDExX3Blbmd1aW5zXxIVMjA0X3ZpZGVvX2NvbmZpZ18yMDRfGhoxMDA1MV9jb21tb25fY29uZmlnXzEwMDUxX4oBDggAEgAiBGlvc18qADIAkAEAmAEA',
  )
    .split('')
    .map((c) => c.charCodeAt(0)),
);

/** 认证请求（bt=1）。真实客户端会连发两次，服务端对重复包是幂等的。 */
export function buildGcsAuth(params: {
  roomId: bigint;
  selfUin: number;
  typeId: number;
  authKey: Uint8Array;
  capabilities?: Uint8Array;
}): Uint8Array {
  const head = buildGcsHead({
    roomId: params.roomId,
    selfUin: params.selfUin,
    sessionTs: 0,
    typeId: params.typeId,
    authKey: params.authKey,
    bodyType: GcsBodyType.authReq,
  });
  return buildGcsPacket(head, params.capabilities ?? DEFAULT_CAPABILITIES);
}

/** 心跳（bt=23）。body 是 fixed32 的单调时钟，服务端只用来算 RTT。 */
export function buildGcsHeartbeat(params: {
  roomId: bigint;
  selfUin: number;
  typeId: number;
  sessionTs: number;
  tick: number;
}): Uint8Array {
  const head = buildGcsHead({
    roomId: params.roomId,
    selfUin: params.selfUin,
    sessionTs: params.sessionTs,
    typeId: params.typeId,
    bodyType: GcsBodyType.heartbeat,
  });
  return buildGcsPacket(head, pbFixed32(1, params.tick));
}

/** ACK 一条推送：`bodyType` 取「推送 + 1」，`typeId` 沿用推送里的。 */
export function buildGcsAck(params: {
  roomId: bigint;
  selfUin: number;
  sessionTs: number;
  typeId: number;
  /** 被 ACK 的推送 bodyType。 */
  pushBodyType: number;
  /** 媒体控制推送的 ACK 要回显配置名，并带 authKey。 */
  pushBody?: Uint8Array;
  authKey?: Uint8Array;
}): Uint8Array {
  const isMediaCtrl = params.pushBodyType === GcsBodyType.mediaCtrlPush;
  const errorCode = params.pushBodyType === GcsBodyType.ctrlPush ? 983041 : 0;
  let body: Uint8Array = new Uint8Array(0);
  if (params.pushBodyType === GcsBodyType.ctrlPush) {
    body = Uint8Array.from([0x08, 0x02]);
  } else if (isMediaCtrl && params.pushBody) {
    const name = pbGetBytes(params.pushBody, 1);
    const type = pbGetVarint(params.pushBody, 2) ?? 1;
    if (name && name.length > 0) {
      body = concat([pbBytes(1, name), pbVarint(2, type), pbVarint(3, 1)]);
    }
  }
  const head = buildGcsHead({
    roomId: params.roomId,
    selfUin: params.selfUin,
    sessionTs: params.sessionTs,
    typeId: params.typeId,
    authKey: isMediaCtrl ? params.authKey : undefined,
    bodyType: params.pushBodyType + 1,
    errorCode,
  });
  return buildGcsPacket(head, body);
}

/**
 * 登出（bt=1003）。body 的 `reason`：2 = 用户主动结束。
 *
 * 真实客户端连发 5 次然后才发 MSF 登出 —— UDP 无连接，单发丢包会让中继一直
 * 挂着这个房间，对端停在「通话中」直到超时。这里也照发 5 次。
 */
export function buildGcsLogout(params: {
  roomId: bigint;
  selfUin: number;
  sessionTs: number;
  typeId: number;
  authKey: Uint8Array;
  reason?: number;
}): Uint8Array {
  const head = buildGcsHead({
    roomId: params.roomId,
    selfUin: params.selfUin,
    sessionTs: params.sessionTs,
    typeId: params.typeId,
    authKey: params.authKey,
    bodyType: GcsBodyType.logout,
  });
  return buildGcsPacket(head, pbVarint(1, params.reason ?? 2));
}

/** 房间事件推送（bt=3）里的事件类型。 */
export const CallEvent = {
  invited: 1,
  entered: 2,
  accepted: 3,
  /** 服务端回的「正在振铃」。名字沿用 wire 语义，**不是**拒绝。 */
  ringing: 4,
  connectFail: 5,
  refusedAlt: 6,
  /** 对端挂断。 */
  logout: 7,
  timeout: 8,
  kickOut: 9,
  /** 对端开始送音频 —— 等同于「已接通」。 */
  dataChange: 10,
} as const;

/** 解析 bt=3 的房间事件。 */
export interface CallEventPush {
  /** 事件序号，同一通电话内递增。 */
  seq: number;
  peerUin: number;
  event: number;
  /** 仅 `logout` 时有值；2 = 正常挂断。 */
  exitReason: number;
}

export function parseCallEvent(body: Uint8Array): CallEventPush | null {
  const seq = pbGetVarint(body, 1) ?? 0;
  const exitReason = pbGetVarint(body, 3) ?? 0;
  const info = pbGetBytes(body, 2);
  if (!info) return null;
  return {
    seq,
    peerUin: pbGetVarint(info, 1) ?? 0,
    event: pbGetVarint(info, 3) ?? 0,
    exitReason,
  };
}

/**
 * 质量上报（bt=15）。
 *
 * **每 2 秒必须发一次**，否则服务端按掉线处理并拆房间。字段值多数照抄真实
 * 客户端的抓包 —— 服务端只对其中几项做语义校验（编码类型、收发包计数、
 * 丢包率），其余是给后台看的数据。
 *
 * `audioDecState` 是关键：告诉对端「我能解 Opus」。不带它，对端会一直用
 * SILK 发（或干脆静音）。
 */
export function buildStatusReport(params: {
  roomId: bigint;
  selfUin: number;
  sessionTs: number;
  typeId: number;
  sendPackets: number;
  recvPackets: number;
  sendBytes: number;
  /** 本次通话内的第几次上报，从 1 起。 */
  seq: number;
}): Uint8Array {
  const tick = Date.now() >>> 0;
  const parts: Uint8Array[] = [];
  parts.push(pbBytes(1, concat([encodeVarint(tick), encodeVarint((tick + 2000) >>> 0)])));
  parts.push(
    pbBytes(2, concat([encodeVarint((tick + 1) >>> 0), encodeVarint((tick + 2001) >>> 0)])),
  );
  for (let i = 3; i <= 7; i++) parts.push(pbVarint(i, 0));
  parts.push(pbVarint(8, params.seq === 1 ? 1 : 0));
  parts.push(pbVarint(9, 0));
  parts.push(pbVarint(10, 0));
  parts.push(pbVarint(11, params.sendPackets));
  parts.push(pbVarint(12, params.recvPackets));
  parts.push(pbVarint(13, params.seq === 1 ? 1 : 0));
  parts.push(pbVarint(14, params.sendBytes));
  parts.push(pbVarint(15, 0));
  parts.push(pbVarint(16, 3)); // 网络类型：3 = 有线
  parts.push(pbVarint(17, 1));
  // f18：网络描述（34 字节），运营商 / 链路类型 / 带宽，照抄真实客户端。
  parts.push(
    pbBytes(
      18,
      Uint8Array.from(
        '0802120a0d6f14122410c03e1802180120cf01285130513804400348b05b50255800'
          .match(/../g)!
          .map((h) => parseInt(h, 16)),
      ),
    ),
  );
  // f19：本端 Penguins 解码状态。`2` 在最后一字节 = 支持 Opus 解码。
  parts.push(pbBytes(19, Uint8Array.from([0x00, 0x01, 0x01, 0x00, 0x00, 0x02, 0x01, 0x00])));
  parts.push(pbVarint(20, 0));
  parts.push(pbVarint(22, 100)); // 质量分
  for (let i = 23; i <= 33; i++) parts.push(pbVarint(i, 0));
  parts.push(pbVarint(36, 0));
  for (let i = 38; i <= 40; i++) parts.push(pbVarint(i, 0));
  parts.push(pbVarint(42, 26280)); // 发送码率
  for (let i = 43; i <= 45; i++) parts.push(pbVarint(i, 0));
  for (let i = 46; i <= 53; i++) parts.push(pbVarint(i, 0xffff));
  parts.push(pbVarint(56, 0));
  parts.push(pbVarint(57, 4));
  for (let i = 58; i <= 66; i++) parts.push(pbVarint(i, 0));
  for (let i = 70; i <= 73; i++) parts.push(pbVarint(i, 0));
  parts.push(pbVarint(84, 0));
  const bitrate = Math.max(4000, Math.min(64000, ((params.sendBytes * 8) / 2) >>> 0));
  parts.push(pbVarint(86, bitrate));
  parts.push(pbVarint(87, Math.max(2000, (bitrate * 0.8) >>> 0)));
  parts.push(pbVarint(88, params.seq === 1 ? 2 : 0)); // 编码：2 = Opus
  parts.push(pbVarint(89, params.sendPackets));
  parts.push(pbVarint(90, params.recvPackets));
  parts.push(pbVarint(99, 0));
  parts.push(pbVarint(100, 0));
  parts.push(pbVarint(105, 0));
  parts.push(pbVarint(110, 0));
  parts.push(pbVarint(111, params.seq));
  for (let i = 112; i <= 115; i++) parts.push(pbVarint(i, 0));
  parts.push(pbVarint(120, 26847424));
  parts.push(pbVarint(123, 0));
  for (let i = 125; i <= 130; i++) parts.push(pbVarint(i, 0));
  parts.push(pbVarint(132, 0));
  parts.push(
    pbBytes(
      133,
      Uint8Array.from(
        '08807d10a120180120807d2814300038034004480150cc0858016001680170007800800101'
          .match(/../g)!
          .map((h) => parseInt(h, 16)),
      ),
    ),
  );
  parts.push(
    pbBytes(
      134,
      Uint8Array.from(
        '0a0c080010001800200028003000120c08001000180020002800300018002000280030003800400048005000580060006800700078008001008801cc08'
          .match(/../g)!
          .map((h) => parseInt(h, 16)),
      ),
    ),
  );
  parts.push(pbVarint(135, params.seq >= 2 ? 2 : 1));
  parts.push(pbBytes(136, new Uint8Array(0)));
  parts.push(pbVarint(137, 0));

  const head = buildGcsHead({
    roomId: params.roomId,
    selfUin: params.selfUin,
    sessionTs: params.sessionTs,
    typeId: params.typeId,
    bodyType: GcsBodyType.statusReport,
  });
  return buildGcsPacket(head, concat(parts));
}

// ═══════════════════════════ Relay (0x02) ═══════════════════════════

export const RELAY_STX = 0x02;
export const RELAY_HEADER_LEN = 37;

export const RelayCmd = {
  getIn: 1,
  getInAck: 2,
  peerPathInfo: 5,
  keepalive: 0x0b,
} as const;

/** 中继通道号的起点；每个中继服务器一个通道，依次 +1。 */
export const RELAY_CHANNEL_BASE = 5000;

function buildRelayPacket(params: {
  roomId: bigint;
  selfUin: number;
  channelId: number;
  authToken: number;
  cmd: number;
  body: Uint8Array;
}): Uint8Array {
  const out = new Uint8Array(RELAY_HEADER_LEN + params.body.length);
  out[0] = RELAY_STX;
  writeU16be(out, 1, out.length);
  writeU16be(out, 3, 0);
  writeU16be(out, 5, params.cmd);
  writeU64be(out, 7, params.roomId);
  writeU32be(out, 19, params.selfUin);
  writeU16be(out, 25, params.channelId);
  // [31:35] 是保留的对端 uin，真实客户端也写 0。
  out[35] = (params.authToken >>> 24) & 0xff;
  out[36] = (params.authToken >>> 16) & 0xff;
  out.set(params.body, RELAY_HEADER_LEN);
  return out;
}

/**
 * 注册到中继（cmd=1）。
 *
 * `authToken` 来自邀请回包；`nonce` 是通道级的随机数，服务端原样带回。
 * 中继只做转发，同一个房间的两个客户端各注册一条通道，服务端把两边的音频
 * 互相投递。
 */
export function buildRelayGetIn(params: {
  roomId: bigint;
  selfUin: number;
  channelId: number;
  authToken: number;
  nonce?: number;
}): Uint8Array {
  const body = new Uint8Array(27);
  body[0] = (params.authToken >>> 8) & 0xff;
  body[1] = params.authToken & 0xff;
  writeU16be(body, 8, params.nonce ?? 0xfe8c);
  // [10:18] 是固定的链路描述（IPv4 / UDP / 端口族），照抄。
  body[16] = 0x02;
  body[17] = 0x05;
  body[18] = 0x27;
  body[19] = 0x4a;
  body[26] = 0x03;
  return buildRelayPacket({ ...params, cmd: RelayCmd.getIn, body });
}

/** 中继保活（cmd=0x0b），5 秒一次。 */
export function buildRelayKeepalive(params: {
  roomId: bigint;
  selfUin: number;
  channelId: number;
  authToken: number;
}): Uint8Array {
  const body = Uint8Array.from([(params.authToken >>> 8) & 0xff, params.authToken & 0xff, 0x03]);
  return buildRelayPacket({ ...params, cmd: RelayCmd.keepalive, body });
}

// ═══════════════════════════ Audio (0x5b) ═══════════════════════════

export const AUDIO_STX = 0x5b;
export const AUDIO_HEADER_LEN = 17;
/** 一帧 Opus 的采样数：16 kHz × 20 ms。 */
export const FRAME_SAMPLES = 320;

/** 0x5b 头里的 `ext_byte`：编码类型。 */
export const CODEC_EXT = {
  silk: 0x05,
  /** `0x2e` 的低 4 位是 14，服务端据此认成 Opus。 */
  opus: 0x2e,
} as const;

/** 0x5b 的 `subType`。 */
export const AudioSubType = {
  audio: 0x01,
  /** 质量反馈。 */
  qfb: 0x0e,
} as const;

interface AudioHeaderParams {
  subType: number;
  seq: number;
  sessionTs: number;
  tick: number;
}

function buildAudioHeader(params: AudioHeaderParams, bodyLen: number): Uint8Array {
  const out = new Uint8Array(AUDIO_HEADER_LEN);
  out[0] = AUDIO_STX;
  writeU16be(out, 1, AUDIO_HEADER_LEN + bodyLen);
  out[3] = params.subType;
  writeU32be(out, 5, params.seq);
  writeU32be(out, 9, params.sessionTs);
  writeU32be(out, 13, params.tick);
  return out;
}

/**
 * 编码器初始化帧（seq=0，`flags=0x53`）。
 *
 * `profile=7` + `ext=0xf9` 是「本端用 Opus（Penguins）编码」的声明；不带它，
 * 对端只会按 SILK 解析我们的包，听到的是噪声。
 *
 * `capabilityHash` 是编码器模型标识，固定值即可 —— 对端只拿它比对能力表。
 */
export function buildCodecInitFrame(params: {
  sessionTs: number;
  tick: number;
  capabilityHash?: number;
}): Uint8Array {
  const rsfec = new Uint8Array(18);
  rsfec[0] = 0x10; // ver=1
  rsfec[1] = 0x03; // type=音频
  rsfec[2] = 0x53; // flags
  rsfec[3] = 0xf9; // ext：channels=2 / profile=7 / sub_type=9
  writeU32be(rsfec, 4, (Date.now() * 48) >>> 0); // 48 kHz 媒体时钟
  writeU32be(rsfec, 8, params.capabilityHash ?? 0x112f88c2);
  rsfec[12] = 0x04;
  rsfec[16] = 0x01;
  const head = buildAudioHeader(
    { subType: AudioSubType.audio, seq: 0, sessionTs: params.sessionTs, tick: params.tick },
    rsfec.length,
  );
  return concat([head, rsfec]);
}

/**
 * 一帧 Opus 音频。
 *
 * RS-FEC 帧头 13 字节 + Opus 载荷 + 2 字节尾零。时间戳由两部分拼成：
 * 高 16 位是样本计数器（每帧 +320），低 16 位是载荷长度 —— 接收端就是把
 * 低 16 位当 `plen` 读的，这不是巧合，是协议设计。
 *
 * `fecContainer` 非空时把 `ver` 改成 0x50 并追加冗余数据（见 {@link buildFecContainer}）。
 */
export function buildAudioFrame(params: {
  seq: number;
  sessionTs: number;
  tick: number;
  /** 样本计数器：`base + 帧序号 × 320`。 */
  sampleCounter: number;
  /** 会话内的帧计数（2 字节，回绕）。 */
  frameCounter: number;
  opus: Uint8Array;
  fecContainer?: Uint8Array;
}): { packet: Uint8Array; rsfec: Uint8Array } {
  const rsfec = new Uint8Array(13 + params.opus.length + 2);
  rsfec[0] = 0x00; // ver=0（RS 编码的输入形态）
  rsfec[1] = 0x03;
  rsfec[2] = 0x3e; // flags：codec + ext + plen + seq + ts
  rsfec[3] = 0x01; // codec
  rsfec[4] = CODEC_EXT.opus;
  writeU16be(rsfec, 5, params.frameCounter & 0xffff);
  writeU16be(rsfec, 7, (params.sampleCounter >>> 16) & 0xffff);
  const subTs = (((params.sampleCounter & 0xffff) << 16) | (params.opus.length & 0xffff)) >>> 0;
  writeU32be(rsfec, 9, subTs);
  rsfec.set(params.opus, 13);

  let sent: Uint8Array = rsfec;
  if (params.fecContainer) {
    sent = concat([rsfec, params.fecContainer]);
    sent[0] = 0x50; // 携带冗余的版本号
  }

  const head = buildAudioHeader(
    {
      subType: AudioSubType.audio,
      seq: params.seq,
      sessionTs: params.sessionTs,
      tick: params.tick,
    },
    sent.length,
  );
  return { packet: concat([head, sent]), rsfec };
}

/** Opus 静音帧（DTX）。8 字节，编码器在无人说话时输出的就是这个。 */
export const OPUS_SILENCE: Uint8Array = Uint8Array.from([
  0xf8, 0xff, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/** 解析 0x5b 头。 */
export interface AudioPacketHeader {
  subType: number;
  seq: number;
  sessionTs: number;
  tick: number;
}

export function parseAudioHeader(data: Uint8Array): AudioPacketHeader | null {
  if (data.length < AUDIO_HEADER_LEN || data[0] !== AUDIO_STX) return null;
  return {
    subType: data[3]!,
    seq: u32be(data, 5),
    sessionTs: u32be(data, 9),
    tick: u32be(data, 13),
  };
}

/** 解析后的音频帧。 */
export interface AudioFrame {
  /** RS-FEC 版本：0 = 原始帧，0x50 = 带冗余。 */
  version: number;
  isOpus: boolean;
  isSilk: boolean;
  /** 样本计数器的高 16 位（低 16 位是载荷长度，已用来切载荷）。 */
  sampleHi: number;
  payload: Uint8Array;
}

/** 从 0x5b 包里抠出音频载荷。 */
export function parseAudioFrame(data: Uint8Array): AudioFrame | null {
  if (data.length < AUDIO_HEADER_LEN + 5) return null;
  const rsfec = data.subarray(AUDIO_HEADER_LEN);
  const version = (rsfec[0]! >>> 4) & 0x0f;
  const flags = rsfec[2]!;
  let off = 3;
  let extByte = 0;
  let sampleHi = 0;
  let payloadLen = 0;

  // 位序：0x20 codec(1B) / 0x10 ext(1B) / 0x08 帧计数(2B) /
  //      0x04 时间戳(4B) / 0x02 载荷长度(2B) / 0x01 能力字段(4B)
  if (flags & 0x20) off += 1;
  if (flags & 0x10) extByte = rsfec[off++]!;
  if (flags & 0x08) {
    if (off + 2 > rsfec.length) return null;
    off += 2;
  }
  if (flags & 0x04) {
    if (off + 4 > rsfec.length) return null;
    sampleHi = u16be(rsfec, off);
    off += 4;
  }
  if (flags & 0x02) {
    if (off + 2 > rsfec.length) return null;
    payloadLen = u16be(rsfec, off);
    off += 2;
  }
  if (flags & 0x01) {
    if (off + 4 > rsfec.length) return null;
    off += 4;
  }
  if (off + payloadLen > rsfec.length) return null;

  return {
    version,
    isOpus: extByte === CODEC_EXT.opus,
    isSilk: extByte === CODEC_EXT.silk,
    sampleHi,
    payload: rsfec.subarray(off, off + payloadLen),
  };
}
