/**
 * LocationShareService —— 位置共享（`QQLBSShareSvc`）：发起 / 上报 / 查询。
 *
 * 与 {@link GroupModerationService} 同构：只负责在在线 pid 上发包，离线 / 风控失败
 * 原样上抛。协议细节见 `@weq/protocol` 的 `msg/lbs-share.ts`。
 *
 * ## 三条命令的分工
 *
 *   {@link start}   建房间（私聊 / 群聊同一套命令，只有会话键不同）
 *   {@link report}  周期上报自己的坐标 —— **必须持续调用**，否则房间超时结束
 *   {@link query}   拉取房间里所有成员的坐标 —— 唯一能拿到别人位置的途径
 *
 * ## 没有「退出共享」
 *
 * 房间靠上报续命，停止上报约 60 秒后服务端自己把状态置为
 * {@link LbsRoomStatus.ENDED}。所以退出 = 停掉心跳，不需要额外命令。
 *
 * ## 卡片要单独发
 *
 * 真实客户端发起后，服务端会推一条「发起了位置共享」消息；但 WeQ 的 SSO 是
 * 「发一包就断」，服务端判定发起方不在线就不投递。所以这里额外提供
 * {@link sendShareCard}，由调用方自己发消息卡片（元素见
 * `buildShareLocationElements`）。
 *
 * ## 调用方注意
 *
 * 本服务**不维护定时器、也不缓存房间状态** —— 心跳节拍由调用方自己驱动
 * （服务端在 `report` 的响应里给出 `interval`，实测 2 秒）。这样做的原因：
 * 渲染层/主进程谁持有会话谁负责生命周期，服务里藏一个 setInterval 会让
 * 「切账号 / 关窗口」时的清理变得不可追踪。
 */
import type { NtHelperBinding } from '@weq/native';
import {
  buildShareLocationElements,
  QueryLocation,
  ReportLocation,
  StartLocationShare,
  type LbsScene,
  type LocationReportResult,
  type LocationRoom,
  type LocationShareStartResult,
} from '@weq/protocol';

/** 一次共享的会话定位。 */
export interface LocationShareTarget {
  /** c2c = 私聊，group = 群聊。 */
  scene: LbsScene;
  /** 私聊：对端 QQ 号。群聊：群号。 */
  peer: number;
  /** 自己的 QQ 号；私聊必填，群聊可省（上报时仍需要）。 */
  selfUin: number;
}

/** 发起共享的参数。 */
export interface StartLocationShareServiceParams extends LocationShareTarget {
  /** 经度（GCJ-02，**经度在前**）。 */
  longitude: number;
  /** 纬度（GCJ-02）。 */
  latitude: number;
  /** 期望上报间隔（秒）；缺省 2。 */
  interval?: number;
}

/** 上报一次坐标的参数。 */
export interface ReportLocationServiceParams extends LocationShareTarget {
  /** 经度（GCJ-02）。 */
  longitude: number;
  /** 纬度（GCJ-02）。 */
  latitude: number;
  /** 语义未确认的 double，缺省 0。 */
  extra?: number;
}

/** 查询房间的参数。 */
export interface QueryLocationServiceParams extends LocationShareTarget {
  /** `0` = 首次，`1` = 轮询（缺省）。 */
  mode?: 0 | 1;
}

/** 发卡片的参数。 */
export interface SendShareCardParams extends LocationShareTarget {
  /** 私聊需要对方 uid（有就带上，新版客户端以 uid 为准）。 */
  peerUid?: string;
}

export class LocationShareService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendPacket'>,
    private readonly resolvePid: () => number,
  ) {}

  /**
   * 发起一次位置共享。返回服务端的结果码（`ok=false` 时看 `code` / `message`）。
   *
   * 发起后**立刻开始按 `interval` 调 {@link report}**，否则房间会超时。
   */
  async start(params: StartLocationShareServiceParams): Promise<LocationShareStartResult> {
    return StartLocationShare.invoke(this.nt, this.resolvePid(), {
      scene: params.scene,
      peer: params.peer,
      selfUin: params.selfUin,
      longitude: params.longitude,
      latitude: params.latitude,
      ...(params.interval !== undefined ? { interval: params.interval } : {}),
    });
  }

  /**
   * 上报一次坐标。响应里的 `interval` 是服务端要求的下次间隔，调用方按它排下一次。
   */
  async report(params: ReportLocationServiceParams): Promise<LocationReportResult> {
    return ReportLocation.invoke(this.nt, this.resolvePid(), {
      scene: params.scene,
      peer: params.peer,
      selfUin: params.selfUin,
      longitude: params.longitude,
      latitude: params.latitude,
      ...(params.extra !== undefined ? { extra: params.extra } : {}),
    });
  }

  /**
   * 查询房间里所有成员的坐标。
   *
   * `status === LbsRoomStatus.ENDED` 说明房间已经结束（停止上报超时），
   * 此时 `members` 会变空。
   */
  async query(params: QueryLocationServiceParams): Promise<LocationRoom> {
    return QueryLocation.invoke(this.nt, this.resolvePid(), {
      scene: params.scene,
      peer: params.peer,
      selfUin: params.selfUin,
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
    });
  }

  /**
   * 发一条「发起了位置共享」消息卡片。
   *
   * 私聊只需要灰条 + 文本；群聊必须额外带 `generalFlags(37)`，否则能显示但点不了。
   * 具体元素由 `buildShareLocationElements` 构造（见 `@weq/protocol`）。
   *
   * 这里**不直接调 sendMessage** —— 发消息要走 `MessageSendService`（它管 uid
   * 解析、字体、装扮）。本方法只负责给出元素，实际发送由调用方转交。
   */
  buildShareCardElements(scene: LbsScene) {
    return buildShareLocationElements(scene);
  }
}
