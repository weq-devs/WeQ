/**
 * 群通话的 `0x28` GCS 控制面。
 *
 * 包格式与私聊相同（`28 | headLen(4BE) | bodyLen(4BE) | head | body | 29`），
 * 但 **head 多一层嵌套**：外层恒为 `f1 = 1 | f2 = <inner>`，字段都在 inner 里。
 * 所以私聊的 `buildGcsHead` 不能直接用，这里单独写一份。
 *
 * 本模块只负责三件事，都是 2026-11-05 逐包核对过的：
 *
 * 1. 解析收到的 `0x28`（含 inner 里的常用字段）；
 * 2. **从 body 里取出服务端下发的会话密钥 k2**（`body.f3.f2`，88 字节）；
 * 3. 组那条应答（body 恒 `22 00`，head 用新密钥、`f2 + 1`、`f11 = 1`）。
 *
 * 为什么 k2 这么重要：认证（`0x02 cmd=0x25`）先带开房回包的 authKey（k1），
 * 服务端随后用这条 `0x28` 下发 k2，之后 GCS head 的 `f6` 与中继
 * `0x13 / 0x73 / 0x11` 里的 88 字节块全都换成 k2。两通抓包各只下发一次、不轮换。
 *
 * 详细的时序见仓库根 `todo.md` §2.2.1。
 */

import { parsePb, pbBytes, pbGetBytes, pbGetVarint, pbVarint } from '../call/gcs';

// ─────────────────────────── 常量 ───────────────────────────

export const GROUP_GCS_STX = 0x28;
export const GROUP_GCS_ETX = 0x29;
/** 会话密钥长度（k1 / k2 都是 88 字节）。 */
export const GROUP_SESSION_KEY_LEN = 88;

/** inner 里各字段的默认值（实测恒定）。 */
export const GROUP_GCS_DEFAULTS = {
  /** `f7`。 */
  f7: 15,
  /** `f8`。 */
  f8: 3,
} as const;

// ─────────────────────────── 结构 ───────────────────────────

/**
 * GCS 的 inner head（群聊版）。
 *
 * 字段含义来自 2026-11-05 的抓包比对（③ 完整一次通话 + ② 视频通话）；
 * `unknown` 里是没建模的 `f30 / f31 / f35` 等嵌套字段，原样保留便于回放。
 */
export interface GroupGcsHead {
  /** `f1`：会话 ID（服务端分配，如 23548 / 612176392 / 73654238）。 */
  sessionId: number;
  /** `f2`：包序号（每包 +1，应答里是收到那条 + 1）。 */
  seq: number;
  /** `f3`：自己 uin。 */
  selfUin: number;
  /** `f4`：入房请求为 0；服务端认证后推送里会写流标识前 4 字节。 */
  f4: number;
  /** `f5`：入房请求为 0；服务端认证后推送里会写流标识尾部派生值。 */
  f5: number;
  /** `f6`：当前会话密钥（88B）；k2 下发后就是 k2。 */
  key: Uint8Array | null;
  /** `f7`：恒 15。 */
  f7: number;
  /** `f8`：恒 3。 */
  f8: number;
  /** `f11`：应答类包置 1。 */
  f11: number;
  /** `f13`：**群号**（实机 673646675），不是媒体会话 ID。 */
  groupId: number;
  f16: number;
  f19: number;
  f20: number;
  f21: number;
  f22: number;
  f23: number;
  /** 未建模的字段。 */
  unknown: Array<{ field: number; value: number | Uint8Array }>;
}

/** 解析后的 `0x28` 包。 */
export interface GroupGcsPacket {
  /** 外层 `f1`（实测恒 1）。 */
  version: number;
  head: GroupGcsHead;
  body: Uint8Array;
  raw: Uint8Array;
}

const HEAD_FIELDS = [1, 2, 3, 4, 5, 6, 7, 8, 11, 13, 16, 19, 20, 21, 22, 23] as const;

export function parseGroupGcsPacket(data: Uint8Array): GroupGcsPacket | null {
  if (data.length < 11 || data[0] !== GROUP_GCS_STX) return null;
  const headLen = readU32be(data, 1);
  const bodyLen = readU32be(data, 5);
  if (9 + headLen + bodyLen + 1 > data.length) return null;
  const outer = data.subarray(9, 9 + headLen);
  const inner = pbGetBytes(outer, 2);
  if (!inner) return null;
  const body = data.subarray(9 + headLen, 9 + headLen + bodyLen);

  const known = new Set<number>(HEAD_FIELDS);
  const unknown: Array<{ field: number; value: number | Uint8Array }> = [];
  for (const field of parseFields(inner)) {
    if (!known.has(field.field)) unknown.push(field);
  }

  return {
    version: pbGetVarint(outer, 1) ?? 0,
    head: {
      sessionId: pbGetVarint(inner, 1) ?? 0,
      seq: pbGetVarint(inner, 2) ?? 0,
      selfUin: pbGetVarint(inner, 3) ?? 0,
      f4: pbGetVarint(inner, 4) ?? 0,
      f5: pbGetVarint(inner, 5) ?? 0,
      key: pbGetBytes(inner, 6) ?? null,
      f7: pbGetVarint(inner, 7) ?? 0,
      f8: pbGetVarint(inner, 8) ?? 0,
      f11: pbGetVarint(inner, 11) ?? 0,
      groupId: pbGetVarint(inner, 13) ?? 0,
      f16: pbGetVarint(inner, 16) ?? 0,
      f19: pbGetVarint(inner, 19) ?? 0,
      f20: pbGetVarint(inner, 20) ?? 0,
      f21: pbGetVarint(inner, 21) ?? 0,
      f22: pbGetVarint(inner, 22) ?? 0,
      f23: pbGetVarint(inner, 23) ?? 0,
      unknown,
    },
    body,
    raw: data,
  };
}

/**
 * 从服务端下发的 `f4` / `f5` 还原 7 字节流标识。
 *
 * **流标识是服务端分配的，不是客户端生成的** —— 2026-11-05 静态比对两通抓包
 * 确认：客户端入房包的 `f4 = f5 = 0`，服务端在应答里回具体的值，之后所有
 * `0x02` 包都用由它还原出的流标识。
 *
 * ```text
 * 应答 f4 = 0x185706aa, f5 = 0x677e0001
 *   → stream = 18 57 06 aa | 67 7e | 00
 *               └─ f4 ─────┘  └f5>>16┘  固定 0x00
 * ```
 *
 * 两通抓包各自验证过（`0x18b606aa`/`0x47320001` → `18b606aa473200`）。
 */
export function streamFromGcsFields(f4: number, f5: number): Uint8Array {
  return Uint8Array.from([
    (f4 >>> 24) & 0xff,
    (f4 >>> 16) & 0xff,
    (f4 >>> 8) & 0xff,
    f4 & 0xff,
    (f5 >>> 24) & 0xff,
    (f5 >>> 16) & 0xff,
    0x00,
  ]);
}

/**
 * 从 7 字节流标识反推 `f4` / `f5`（{@link streamFromGcsFields} 的逆运算）。
 *
 * 只在构造后续包（认证 / 订阅 / 媒体）时用；首次入房包的 `f4/f5` 必须是 0。
 */
export function gcsFieldsFromStream(stream: Uint8Array): { f4: number; f5: number } {
  if (stream.length !== 7) throw new RangeError(`流标识必须是 7 字节，收到 ${stream.length}`);
  return {
    f4: ((stream[0]! << 24) | (stream[1]! << 16) | (stream[2]! << 8) | stream[3]!) >>> 0,
    f5: ((((stream[4]! << 8) | stream[5]!) << 16) | 1) >>> 0,
  };
}

/**
 * 组 inner head。
 *
 * **字段顺序必须与抓包一致**：f1…f8、f11、f13、f16、f19…f23，最后才是未建模字段。
 * 少写 `f13`（群号）服务端不认房间；把 `f11` 放在 `f8` 之后而不是末尾则字节对不上。
 *
 * `f13 / f16 / f19…f23` 只在**入房 / 认证类**的完整头里出现，应答类包（精简头）
 * 里是 0 —— 0 的字段不写出来，正好对上抓包。
 */
export function buildGroupGcsHead(head: GroupGcsHead): Uint8Array {
  const parts: Uint8Array[] = [
    pbVarint(1, head.sessionId),
    pbVarint(2, head.seq),
    pbVarint(3, head.selfUin),
    pbVarint(4, head.f4),
    pbVarint(5, head.f5),
  ];
  if (head.key && head.key.length > 0) parts.push(pbBytes(6, head.key));
  parts.push(pbVarint(7, head.f7), pbVarint(8, head.f8));
  if (head.f11) parts.push(pbVarint(11, head.f11));
  if (head.groupId) parts.push(pbVarint(13, head.groupId));
  if (head.f16) parts.push(pbVarint(16, head.f16));
  for (const field of [19, 20, 21, 22, 23] as const) {
    const value = head[`f${field}` as 'f19' | 'f20' | 'f21' | 'f22' | 'f23'];
    if (value) parts.push(pbVarint(field, value));
  }
  for (const extra of head.unknown) {
    parts.push(
      typeof extra.value === 'number'
        ? pbVarint(extra.field, extra.value)
        : pbBytes(extra.field, extra.value),
    );
  }
  return concat(parts);
}

/** 包成 `28 | headLen(4) | bodyLen(4) | head | body | 29`。 */
export function buildGroupGcsPacket(innerHead: Uint8Array, body: Uint8Array): Uint8Array {
  const head = concat([pbVarint(1, 1), pbBytes(2, innerHead)]);
  const out = new Uint8Array(10 + head.length + body.length);
  out[0] = GROUP_GCS_STX;
  writeU32be(out, 1, head.length);
  writeU32be(out, 5, body.length);
  out.set(head, 9);
  out.set(body, 9 + head.length);
  out[out.length - 1] = GROUP_GCS_ETX;
  return out;
}

/**
 * 组首次入房用的 GCS 包。
 *
 * 抓包里的首包 head 是 `f1=sessionId, f2=265, f3=selfUin, f4=0, f5=0,
 * f6=k1, f7=15, f8=3`；群号和认证后才出现的字段此时都不带。`body` 是
 * AVSDK 的 964 字节能力块，协议层不解释它，由调用方提供。
 */
export function buildGroupGcsEntry(params: {
  sessionId: number;
  selfUin: number;
  key: Uint8Array;
  body: Uint8Array;
  seq?: number;
}): Uint8Array {
  if (params.key.length !== GROUP_SESSION_KEY_LEN) {
    throw new RangeError(
      `群通话 k1 必须是 ${GROUP_SESSION_KEY_LEN} 字节，收到 ${params.key.length}`,
    );
  }
  const head = buildGroupGcsHead({
    sessionId: params.sessionId,
    seq: params.seq ?? 265,
    selfUin: params.selfUin,
    f4: 0,
    f5: 0,
    key: params.key,
    f7: GROUP_GCS_DEFAULTS.f7,
    f8: GROUP_GCS_DEFAULTS.f8,
    f11: 0,
    groupId: 0,
    f16: 0,
    f19: 0,
    f20: 0,
    f21: 0,
    f22: 0,
    f23: 0,
    unknown: [],
  });
  return buildGroupGcsPacket(head, params.body);
}

/**
 * 组「收到一条 s2c 之后的应答」。
 *
 * `f6` = **当前**密钥（刚下发的 k2 立刻生效，哪怕是用来应答那条 `hl=63` 的精简头
 * 推送），`f11` = 1；`f13` / `f16` / `f19…f23` 与未建模字段都不写。body 恒为
 * `22 00`（field 4 空消息）。
 *
 * ⚠️ **`f1` / `f2` 都按「本端那一路」算，不是照抄收到的那条**。
 * 服务端给每条 s2c 流分配独立的会话 ID 和自己的序号序列，③ 抓包里
 * k2 下发包是 `f1 = 23552, f2 = 278`，紧随其后的应答是
 * `f1 = 612176395, f2 = 284` —— 两个字段分别属于两条流。
 * 会话层要自己维护 `(sessionId, seq)`，所以这里两个值都从 `options` 取。
 */
export function buildGroupGcsAck(
  options: { key?: Uint8Array; sessionId: number; seq: number },
  received: GroupGcsHead,
): Uint8Array {
  const head: GroupGcsHead = {
    ...received,
    sessionId: options.sessionId,
    seq: options.seq,
    key: options.key ?? received.key,
    f11: 1,
    groupId: 0,
    f16: 0,
    f19: 0,
    f20: 0,
    f21: 0,
    f22: 0,
    f23: 0,
    unknown: [],
  };
  return buildGroupGcsPacket(buildGroupGcsHead(head), pbBytes(4, new Uint8Array(0)));
}

// ─────────────────────────── 会话密钥 k2 ───────────────────────────

/**
 * 从 `0x28` 的 body 里取服务端下发的会话密钥。
 *
 * 下发包 body 是 `f3{ f2: 88B 密钥, f4×3, f5=1, f6=0, f7×5, f8=0, f10×4 }`，
 * 两通抓包里各出现一次；不是这种包就返回 null。
 */
export function extractGroupSessionKey(body: Uint8Array): Uint8Array | null {
  const push = pbGetBytes(body, 3);
  if (!push || push.length < 4) return null;
  const key = pbGetBytes(push, 2);
  if (!key || key.length !== GROUP_SESSION_KEY_LEN) return null;
  return key;
}

/** 下发包里的其余信息（调试/日志用）。 */
export interface GroupSessionKeyPush {
  key: Uint8Array;
  /** 子消息里 `f10` 的每项（每项 14 字节，实测 4 项，语义未解）。 */
  streams: Uint8Array[];
  raw: Uint8Array;
}

export function parseGroupSessionKeyPush(body: Uint8Array): GroupSessionKeyPush | null {
  const key = extractGroupSessionKey(body);
  if (!key) return null;
  const push = pbGetBytes(body, 3)!;
  const streams: Uint8Array[] = [];
  for (const field of parseFields(push)) {
    if (field.field === 10 && field.value instanceof Uint8Array) streams.push(field.value);
  }
  return { key, streams, raw: push };
}

// ─────────────────────────── 小工具 ───────────────────────────

function readU32be(buf: Uint8Array, off: number): number {
  return ((buf[off]! << 24) | (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!) >>> 0;
}

function writeU32be(buf: Uint8Array, off: number, value: number): void {
  buf[off] = (value >>> 24) & 0xff;
  buf[off + 1] = (value >>> 16) & 0xff;
  buf[off + 2] = (value >>> 8) & 0xff;
  buf[off + 3] = value & 0xff;
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

/** 平铺解析一层，把 `value` / `bytes` / `fixed32` 归一成一个值。 */
function parseFields(buf: Uint8Array): Array<{ field: number; value: number | Uint8Array }> {
  return parsePb(buf).map((field) => ({
    field: field.field,
    value: field.bytes ?? field.fixed32 ?? Number(field.value ?? 0),
  }));
}
