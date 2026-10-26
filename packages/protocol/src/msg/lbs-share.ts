/**
 * 位置共享（`QQLBSShareSvc`）—— 私聊 / 群聊两条场景共用一套命令。
 *
 * 三条命令都是 **raw SSO**（不套 OIDB 信封），`needSign = false`：
 *
 *   QQLBSShareSvc.room_operation    发起 / 进入共享
 *   QQLBSShareSvc.report_location   周期上报自己的坐标
 *   QQLBSShareSvc.query_location    拉取房间里所有成员的最新坐标（命令名见下）
 *
 * ## 会话键（三条命令的 field 1）
 *
 * `room_operation` 与查询用**场景键**：
 *
 *   私聊 `{ 1: 2(scene C2C), 2: 小号, 3: 大号 }`   ← 两个参与者按 uin 升序，不是「对端/自己」
 *   群聊 `{ 1: 1(scene 群),  2: groupCode, 3: 0 }`
 *
 * ⚠️ 私聊这一对**必须按规范顺序**（见 {@link canonicalPair}）：服务端不认语义
 * 位置，同一对号无论谁发包，`1.2` / `1.3` 都得是小号在前、大号在后。写反了
 * 服务端直接回 `10001 param error`（实测 1707889225↔2863253201 双向验证）。
 * 早期实现按「peer / selfUin」写，只有在「自己恰好是大号」时才碰巧正确。
 *
 * `report_location` 的 `1.1` 恒为 `2`；私聊同样按规范顺序，群聊 `1.2` 换成群号。
 * 所以它单独用 {@link reportKey}。
 *
 * ## 房间不是服务端分配的
 *
 * 服务端**不返回房间号**：私聊的房间就是「这两个人」，群聊的就是「这个群」。
 * `room_operation` 的响应只有 `{ code, message }`，后续所有命令靠调用方自己拼
 * 同一个会话键来定位。
 *
 * ## 生命周期
 *
 * 房间靠 `report_location` 心跳续命（响应里的 `interval` 告诉下次多久再报，
 * 实测 2 秒）。停止上报约 60 秒后服务端把房间标记为已结束（查询响应 `status`
 * 从 1 变 2），所以**「退出共享」不需要单独的命令** —— 不报即可。
 *
 * ## 坐标
 *
 * **GCJ-02**，**经度在前**，double。`report_location` 的 field 4 是每次调用都
 * 变的 double（实测 70~255），服务端原样存下并在查询响应的成员条目 field 5 回显；
 * 语义未确认，疑似定位精度半径。给个稳定值即可，服务端不校验。
 *
 * ## 消息卡片不在这里
 *
 * 真实客户端发起后，服务端会用 `MsgPush` 投递一条「发起了位置共享」消息。但
 * WeQ 的 SSO 是「发一包就断」，服务端判定发起方不在线就不投递 —— 所以**卡片
 * 由调用方自己 `sendMessage` 发**，元素构造见 {@link buildShareLocationElements}。
 */
import { message } from '../protobuf';
import { invokeTrpc, type TrpcSpec } from '../oidb/invoke';
import type { TrpcNative } from '../transport';
import type { SendElement } from './send-elements';

// ───────────────────────── 公共 schema ─────────────────────────

/**
 * 会话键（`room_operation` / 查询用）。
 *
 * ⚠️ 私聊的 tag 2 / tag 3 **不是「对端 / 自己」**，而是两个参与者的**规范顺序**
 * （小号在前，见 {@link canonicalPair}）。群聊的 tag 2 是群号、tag 3 恒 0。
 */
const SESSION_KEY = message([
  { name: 'scene', tag: 1, type: 'uint32' },
  { name: 'uinA', tag: 2, type: 'uint64' },
  { name: 'uinB', tag: 3, type: 'uint64' },
]);

/** 上报用的会话键（`1.1` 恒为 2；私聊同样按规范顺序，群聊 `1.2` 是群号）。 */
const REPORT_KEY = message([
  { name: 'scene', tag: 1, type: 'uint32' },
  { name: 'uinA', tag: 2, type: 'uint64' },
  { name: 'uinB', tag: 3, type: 'uint64' },
]);

/** 统一的 `{ code, message }` 结果块。 */
const RESULT = message([
  { name: 'code', tag: 1, type: 'uint32' },
  { name: 'message', tag: 2, type: 'string' },
]);

/** `scene` 取值：群聊。 */
export const LBS_SCENE_GROUP = 1;
/** `scene` 取值：私聊。 */
export const LBS_SCENE_C2C = 2;

/** 房间状态（查询响应 field 5）。 */
export const LbsRoomStatus = {
  /** 进行中。 */
  ACTIVE: 1,
  /** 已结束（停止上报约 60 秒后服务端置为此值）。 */
  ENDED: 2,
} as const;

/** 共享场景。 */
export type LbsScene = 'c2c' | 'group';

/**
 * 会话键参数。私聊给 `peerUin` + `selfUin`；群聊给 `groupId`（`selfUin` 不参与）。
 */
export interface LbsSession {
  scene: LbsScene;
  /** 私聊：对端 QQ 号。群聊：群号。 */
  peer: number;
  /** 私聊必填（自己 QQ 号）；群聊忽略。 */
  selfUin?: number;
}

/**
 * 私聊会话键的两个参与者：**小号在前**。
 *
 * 服务端不认「对端 / 自己」的语义顺序，只认这个规范顺序 —— 同一对号的两个方向
 * 发出的包必须逐字节相同。实测（两账号分别发包 + 安卓抓包三方互证）：
 *
 *   field2 = 1707889225, field3 = 2863253201  → ok
 *   field2 = 2863253201, field3 = 1707889225  → `10001 param error`
 *
 * 与「谁发包」无关，所以绝不能按 `peer` / `selfUin` 的位置直接写 wire。
 */
function canonicalPair(a: number, b: number): { uinA: number; uinB: number } {
  return a < b ? { uinA: a, uinB: b } : { uinA: b, uinB: a };
}

/** 校验并收窄 `selfUin`（`LbsSession.selfUin` 是 optional，`Number.isSafeInteger` 不收窄）。 */
function requireSelfUin(s: LbsSession, what: string): number {
  const selfUin = s.selfUin;
  if (!Number.isSafeInteger(selfUin) || (selfUin ?? 0) <= 0) {
    throw new Error(`${what} 必须给 selfUin（自己的 QQ 号）`);
  }
  return selfUin as number;
}

/** 把 {@link LbsSession} 归一成 wire 上的会话键。 */
function sessionKey(s: LbsSession): Record<string, unknown> {
  if (!Number.isSafeInteger(s.peer) || s.peer <= 0) {
    throw new Error(`peer 必须是正整数，收到 ${String(s.peer)}`);
  }
  if (s.scene === 'group') {
    return { scene: LBS_SCENE_GROUP, uinA: s.peer, uinB: 0 };
  }
  const selfUin = requireSelfUin(s, '私聊位置共享');
  return { scene: LBS_SCENE_C2C, ...canonicalPair(selfUin, s.peer) };
}

/** 上报用的会话键：`1.1` 恒为 2；私聊同样按规范顺序，群聊 `1.2` 是群号。 */
function reportKey(s: LbsSession): Record<string, unknown> {
  const selfUin = requireSelfUin(s, 'report_location');
  if (s.scene === 'group') {
    return { scene: LBS_SCENE_C2C, uinA: s.peer, uinB: selfUin };
  }
  return { scene: LBS_SCENE_C2C, ...canonicalPair(selfUin, s.peer) };
}

// ───────────────────────── 发起 ─────────────────────────

const ROOM_OPERATION_REQ = message([
  { name: 'session', tag: 1, type: SESSION_KEY },
  { name: 'op', tag: 2, type: 'uint32' },
  { name: 'interval', tag: 3, type: 'uint32' },
  { name: 'longitude', tag: 4, type: 'double' },
  { name: 'latitude', tag: 5, type: 'double' },
]);
const ROOM_OPERATION_RESP = message([{ name: 'result', tag: 1, type: RESULT }]);

export interface StartLocationShareParams extends LbsSession {
  /** 经度（GCJ-02）。 */
  longitude: number;
  /** 纬度（GCJ-02）。 */
  latitude: number;
  /** 期望的上报间隔（秒）。抓包里固定 2。 */
  interval?: number;
}

export interface LocationShareStartResult {
  ok: boolean;
  code: number;
  message: string;
}

/**
 * 发起（或加入）一次位置共享。
 *
 * 响应只有结果码 —— 房间不是服务端分配的，后续靠同一个会话键定位。
 */
export namespace StartLocationShare {
  export const cmd = 'QQLBSShareSvc.room_operation';
  export const needSign = false;
  export const reqSchema = ROOM_OPERATION_REQ;
  export const respSchema = ROOM_OPERATION_RESP;

  export type Params = StartLocationShareParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    session: sessionKey(p),
    op: 1,
    interval: p.interval ?? 2,
    longitude: requireCoord(p.longitude, 'longitude', 180),
    latitude: requireCoord(p.latitude, 'latitude', 90),
  });

  export const deserialize = (body: Record<string, unknown>): LocationShareStartResult => {
    const result = (body.result ?? {}) as Record<string, unknown>;
    const code = Number(result.code ?? 0);
    return {
      ok: code === 0,
      code,
      message: typeof result.message === 'string' ? result.message : '',
    };
  };

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: Params,
  ): Promise<LocationShareStartResult> =>
    invokeTrpc(nt, pid, StartLocationShare as TrpcSpec<Params, LocationShareStartResult>, params);
}

// ───────────────────────── 上报 ─────────────────────────

const REPORT_LOCATION_REQ = message([
  { name: 'session', tag: 1, type: REPORT_KEY },
  { name: 'longitude', tag: 2, type: 'double' },
  { name: 'latitude', tag: 3, type: 'double' },
  { name: 'extra', tag: 4, type: 'double' },
]);
const REPORT_LOCATION_RESP = message([
  { name: 'result', tag: 1, type: RESULT },
  { name: 'interval', tag: 2, type: 'uint32' },
]);

export interface ReportLocationParams extends LbsSession {
  /** 经度（GCJ-02）。 */
  longitude: number;
  /** 纬度（GCJ-02）。 */
  latitude: number;
  /**
   * 语义未确认的 double（抓包实测每次调用都变，值域 70~255）。服务端原样存下
   * 并在查询响应的成员条目里回显，不参与校验。缺省给 0。
   */
  extra?: number;
}

export interface LocationReportResult {
  ok: boolean;
  code: number;
  message: string;
  /** 服务端要求的下次上报间隔（秒）；缺省 2。 */
  interval: number;
}

/**
 * 上报一次自己的坐标。**必须按服务端给的 `interval` 持续调用**，否则房间会超时结束。
 */
export namespace ReportLocation {
  export const cmd = 'QQLBSShareSvc.report_location';
  export const needSign = false;
  export const reqSchema = REPORT_LOCATION_REQ;
  export const respSchema = REPORT_LOCATION_RESP;

  export type Params = ReportLocationParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    session: reportKey(p),
    longitude: requireCoord(p.longitude, 'longitude', 180),
    latitude: requireCoord(p.latitude, 'latitude', 90),
    extra: p.extra ?? 0,
  });

  export const deserialize = (body: Record<string, unknown>): LocationReportResult => {
    const result = (body.result ?? {}) as Record<string, unknown>;
    const code = Number(result.code ?? 0);
    return {
      ok: code === 0,
      code,
      message: typeof result.message === 'string' ? result.message : '',
      interval: Number(body.interval ?? 2) || 2,
    };
  };

  export const invoke = (
    nt: TrpcNative,
    pid: number,
    params: Params,
  ): Promise<LocationReportResult> =>
    invokeTrpc(nt, pid, ReportLocation as TrpcSpec<Params, LocationReportResult>, params);
}

// ───────────────────────── 查询 ─────────────────────────

/** 房间里的一个成员（查询响应 field 2，repeated）。 */
const ROOM_MEMBER = message([
  { name: 'uin', tag: 1, type: 'uint64' },
  { name: 'joinedAt', tag: 2, type: 'uint32' },
  { name: 'longitude', tag: 3, type: 'double' },
  { name: 'latitude', tag: 4, type: 'double' },
  /** 回显该成员最近一次上报的 `extra`。 */
  { name: 'extra', tag: 5, type: 'double' },
  { name: 'reportedAt', tag: 6, type: 'uint32' },
]);

const QUERY_LOCATION_REQ = message([
  { name: 'session', tag: 1, type: SESSION_KEY },
  { name: 'mode', tag: 2, type: 'uint32' },
]);
const QUERY_LOCATION_RESP = message([
  { name: 'result', tag: 1, type: RESULT },
  { name: 'members', tag: 2, type: ROOM_MEMBER, repeated: true },
  { name: 'selfUin', tag: 3, type: 'uint64' },
  { name: 'startedAt', tag: 4, type: 'uint32' },
  { name: 'status', tag: 5, type: 'uint32' },
  { name: 'field7', tag: 7, type: 'uint32' },
]);

export interface QueryLocationParams extends LbsSession {
  /**
   * 查询模式。`0` = 首次（还没上报过时成员条目坐标为 0），`1` = 轮询。
   * 抓包里客户端在发起后会并发发多条，这里按需调用即可。
   */
  mode?: 0 | 1;
}

/** 房间成员。 */
export interface LocationRoomMember {
  /** 成员 QQ 号。 */
  uin: number;
  /** 进入共享的时间（unix 秒）。 */
  joinedAt: number;
  /** 经度（GCJ-02）；没上报过时为 0。 */
  longitude: number;
  /** 纬度（GCJ-02）；没上报过时为 0。 */
  latitude: number;
  /** 该成员最近一次上报的 `extra`（语义未确认）。 */
  extra: number;
  /** 最近一次上报时间（unix 秒）。 */
  reportedAt: number;
}

export interface LocationRoom {
  ok: boolean;
  code: number;
  message: string;
  /** 房间成员（含自己）。 */
  members: LocationRoomMember[];
  /** 自己的 QQ 号。 */
  selfUin: number;
  /** 共享开始时间（unix 秒）。 */
  startedAt: number;
  /** 房间状态，见 {@link LbsRoomStatus}。 */
  status: number;
  /** 未知字段，抓包里恒为 5。 */
  field7: number;
}

/**
 * 查询房间里所有成员的最新坐标。这是**唯一**能拿到别人位置的方式 ——
 * 位置不会通过消息推送过来。
 */
export namespace QueryLocation {
  export const cmd = 'QQLBSShareSvc.room_query';
  export const needSign = false;
  export const reqSchema = QUERY_LOCATION_REQ;
  export const respSchema = QUERY_LOCATION_RESP;

  export type Params = QueryLocationParams;

  export const serialize = (p: Params): Record<string, unknown> => ({
    session: sessionKey(p),
    mode: p.mode ?? 1,
  });

  export const deserialize = (body: Record<string, unknown>): LocationRoom => {
    const result = (body.result ?? {}) as Record<string, unknown>;
    const code = Number(result.code ?? 0);
    const rawMembers = Array.isArray(body.members) ? body.members : [];
    return {
      ok: code === 0,
      code,
      message: typeof result.message === 'string' ? result.message : '',
      members: rawMembers.map((raw) => {
        const m = (raw ?? {}) as Record<string, unknown>;
        return {
          uin: Number(m.uin ?? 0),
          joinedAt: Number(m.joinedAt ?? 0),
          longitude: Number(m.longitude ?? 0),
          latitude: Number(m.latitude ?? 0),
          extra: Number(m.extra ?? 0),
          reportedAt: Number(m.reportedAt ?? 0),
        };
      }),
      selfUin: Number(body.selfUin ?? 0),
      startedAt: Number(body.startedAt ?? 0),
      status: Number(body.status ?? 0),
      field7: Number(body.field7 ?? 0),
    };
  };

  export const invoke = (nt: TrpcNative, pid: number, params: Params): Promise<LocationRoom> =>
    invokeTrpc(nt, pid, QueryLocation as TrpcSpec<Params, LocationRoom>, params);
}

// ───────────────────────── 消息卡片元素 ─────────────────────────

/**
 * 「发起了位置共享」灰条的 `pbElem` 字节 = `{ 1: "发起了位置共享" }`。
 *
 * 灰条本身不是独立协议，就是 `commonElem serviceType=31` —— 客户端按文案 +
 * 当前会话的共享状态渲染成位置共享卡片。
 */
const SHARE_LOCATION_TIP_PB = Uint8Array.from([
  0x0a, 0x15, 0xe5, 0x8f, 0x91, 0xe8, 0xb5, 0xb7, 0xe4, 0xba, 0x86, 0xe4, 0xbd, 0x8d, 0xe7, 0xbd,
  0xae, 0xe5, 0x85, 0xb1, 0xe4, 0xba, 0xab,
]);

/** 灰条文案。 */
export const SHARE_LOCATION_TEXT = '发起了位置共享';

/**
 * 构造「发起了位置共享」消息的元素。
 *
 * **私聊**只要灰条 + 文本兜底就够（客户端会渲染成可点的卡片）。
 *
 * **群聊必须额外带 `generalFlags(37)`**，否则能显示但**点不了** —— 实测差异就在
 * 这一块。里面 `font.token116` 对应消息头的 `1.2.32`（服务端下发时回填的同一个
 * 8 字节值），客户端编不出来；这里给 0 由服务端重新生成。
 *
 * 注意 `encode()` 只按 schema 的 `field.name` 取值，`FONT_INFO` / `GENERAL_FLAGS`
 * 里没声明的 tag 会被**静默丢弃** —— 所以这两个 schema 必须保留位置共享用到的那
 * 一批 tag（见 `./schemas`）。
 */
export function buildShareLocationElements(scene: LbsScene): SendElement[] {
  const elements: SendElement[] = [
    {
      kind: 'raw',
      elem: {
        commonElem: {
          serviceType: 31,
          pbElem: SHARE_LOCATION_TIP_PB,
          businessType: 1,
        },
      },
    },
  ];

  if (scene === 'group') {
    elements.push({
      kind: 'raw',
      elem: {
        generalFlags: {
          bubbleDiyTextId: 0,
          groupFlagNew: 0,
          flag10: 0,
          flag12: 0,
          flag13: 0,
          widgetId: 104228,
          font: {
            flag1: 0,
            flag4: 10315,
            fontId2: 65536,
            flag20: 36097,
            flag25: 0,
            flag30: 0,
            flag31: 0,
            flag34: 0,
            flag51: 337,
            flag52: 4,
            flag54: 0,
            fontId1: 0,
            flag58: 0,
            flag61: 0,
            nested65: { flag2: 14 },
            flag66: 100664448,
            flag71: 2,
            flag72: 0,
            nested73: { flag2: 0, flag6: 4 },
            flag79: 163904,
            flag81: 16,
            nested102: { inner: { a: 0, b: 0, c: 0, d: 0 } },
            flag107: 1100,
            // 用 number 而不是 bigint：这组元素要经 IPC 从渲染层传到主进程，
            // 而 IPC 的还原函数（`elementsFromEditable`）只还原 Buffer、不认 bigint。
            token116: 0,
          },
        },
      },
    });
  }

  elements.push({ kind: 'raw', elem: { text: { str: SHARE_LOCATION_TEXT } } });
  return elements;
}

// ───────────────────────── 校验 ─────────────────────────

function requireCoord(value: number, what: string, limit: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    throw new Error(`${what} 必须是 ±${limit} 内的有限数，收到 ${String(value)}`);
  }
  return value;
}
