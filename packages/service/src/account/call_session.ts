/**
 * 语音通话会话：状态机 + 收发编排。
 *
 * 一次通话的三条腿：
 *
 *   1. **信令**（TCP，借 SSO）：开房、邀请、挂断。走 `@weq/protocol` 的
 *      `startC2CCall` / `endC2CCall`，只需要已登记的 pid。
 *   2. **控制面**（UDP → GCS）：认证、心跳、状态上报、房间事件。
 *   3. **媒体**（UDP → GCS）：Opus 帧收发，20 ms 一帧。
 *
 * relay 通道（`0x02`）是补充路径：服务端在 UDP 直连不通时用它中继，正常链路下
 * 注册了就行，不依赖它送音频。
 *
 * 这个模块**不碰 Electron、不碰 native**：UDP 用 {@link UdpTransport}，编解码用
 * {@link CallAudioCodec}，两者由主进程注入。这样状态机可以在单测里用假时钟和
 * 假 socket 跑完整个生命周期。
 *
 * ⚠️ 只做主动发起。来电推送由 QQ 本体的 AVSDK 消费，我们借凭据发包，收不到那条
 * push，所以没有「被动接听」这条路径。
 */

import {
  AUDIO_STX,
  AudioSubType,
  RelayCmd,
  type AudioFrame,
  type CallRoom,
  CallEvent,
  type CallServer,
  DEFAULT_CAPABILITIES,
  FRAME_SAMPLES,
  GCS_STX,
  GCS_TYPE_ID_BASE,
  GcsBodyType,
  OPUS_SILENCE,
  RELAY_CHANNEL,
  RELAY_HEADER_LEN,
  RELAY_STX,
  PeerProbeCmd,
  buildAudioFrame,
  buildCodecInitFrame,
  buildFecContainer,
  buildGcsAck,
  buildGcsAuth,
  buildGcsHeartbeat,
  buildGcsLogout,
  buildPeerJoinReport,
  buildPeerProbe,
  buildPeerProbeReply,
  buildQfbRequest,
  buildQfbResponse,
  buildRelayGetIn,
  buildRelayKeepalive,
  buildRelayPacket,
  buildStatusReport,
  buildVideoControl,
  buildVideoKeepalive,
  buildVideoPackets,
  buildVideoState,
  buildVideoSubHeader,
  extractHevc,
  parseAudioFrame,
  parseAudioHeader,
  parseCallEvent,
  parseFecContainer,
  parseGcsPacket,
  parsePb,
  parsePeerJoin,
  parsePeerProbe,
  parseQfb,
  pbGetVarint,
  parseVideoPacket,
  rsEncode,
  sampleVideoFrameQuality,
  splitHevcNals,
  isIrapNalType,
  VIDEO_SUBHEADER_LEN,
  VIDEO_CTRL_SUB_TYPE,
  VideoStateCode,
  videoPacketCount,
  VIDEO_KEEPALIVE_SUB_TYPE,
  VideoFrameAssembler,
  isVideoSubType,
  endC2CCall,
  startC2CCall,
} from '@weq/protocol';
import type { Logger } from '../common/logger';

// ─────────────────────────── 状态 ───────────────────────────

export type CallState =
  /** 还没开始 / 已彻底结束。 */
  | 'idle'
  /** 开房 + 邀请已发出，等对端响应。 */
  | 'calling'
  /** 对端正在振铃（服务端回了 event=4）。 */
  | 'ringing'
  /** 对端已进入房间但还没开始送音频。 */
  | 'connecting'
  /** 双向音频已通。 */
  | 'connected'
  /** 正在挂断。 */
  | 'ending'
  /** 已结束（正常挂断）。 */
  | 'ended'
  /** 异常结束（失败 / 超时 / 被踢）。 */
  | 'failed';

/** 挂断原因，会透给界面。 */
export type CallEndReason =
  | 'hangup'
  | 'peer_hangup'
  | 'peer_refused'
  | 'timeout'
  | 'connect_fail'
  | 'kicked'
  | 'error';

export interface CallSnapshot {
  state: CallState;
  /** 房间号（十进制串，给日志与界面用）。 */
  roomId: string | null;
  peerUin: string;
  peerUid: string;
  /** 通话开始时刻（毫秒）。 */
  startedAt: number | null;
  /** 接通时刻；未接通为 null。 */
  connectedAt: number | null;
  /** 结束时原因。 */
  endReason: CallEndReason | null;
  /** 最近一次错误。 */
  lastError: string | null;
  /** 收发的音频帧计数（调试 / 界面波形用）。 */
  sentFrames: number;
  receivedFrames: number;
  /** 本端摄像头是否开着（发视频中）。 */
  videoSending: boolean;
  /** 对端摄像头是否开着（收到对端视频流）。 */
  videoReceiving: boolean;
  /** 收到的视频帧数。 */
  receivedVideoFrames: number;
  /** 视频流的最近一次关键帧信息；没收到过为 null。 */
  videoInfo: VideoStreamInfo | null;
  /**
   * 本端正在发的画面来自哪里：摄像头还是屏幕共享。
   *
   * **只影响本端采集与显示**，协议层不分这两者（都是主视频流）。界面用它决定
   * 本端小窗的画法（共享时不要镜像、也不该裁成圆形）。
   */
  videoSource: CallVideoSource;
  /** 本端视频编码档位（采集端按它缩放）。还没开过视频时为 null。 */
  videoProfile: CallVideoEncoding | null;
}

/**
 * 本端画面的采集来源。
 *
 * **协议层不区分这两者** —— 屏幕共享就是一路普通主视频流（`0x5b subType=2`），
 * 与摄像头共用 `subType=4` 开关、`subType=5` 保活、`bt=31` 状态交换。这个类型只
 * 用来让界面决定本端画面怎么显示（共享时不该做镜像 / 圆形裁切）。
 *
 * 具体要多少分辨率、多少码率由主进程的采集档位决定，`@weq/service` 只负责把
 * 「当前是哪一档」原样透传给界面，不关心数值本身。
 */
export type CallVideoSource = 'camera' | 'screen';

/** 本端视频的编码档位（由主进程的采集档位决定，服务层只透传）。 */
export interface CallVideoEncoding {
  width: number;
  height: number;
  fps: number;
  bitrateKbps: number;
}

/** 从 SPS 里读出来的视频规格。 */
export interface VideoStreamInfo {
  width: number;
  height: number;
  /** HEVC profile（1 = Main）。 */
  profile: number;
  /** 编码格式，目前只认 hevc。 */
  codec: 'hevc';
  /** 编码帧率（可选）。 */
  fps?: number;
  /** 目标码率（kbps，可选）。 */
  bitrateKbps?: number;
}

// ─────────────────────────── 依赖注入 ───────────────────────────

/** 一个 UDP 套接字的最小表面（真实实现是 `node:dgram`）。 */
export interface UdpTransport {
  /** 绑定本地端口（0 = 随机）。 */
  bind(): Promise<void>;
  /**
   * 绑定后的本地端口。
   *
   * `bt=25` 要向服务端公告**本端的 P2P 端口**，对端随后就打这个端口。拿不到时
   * （老实现 / 测试里的假 socket）跳过公告 —— 但那样 P2P 永远建不起来，所以真实
   * 实现必须给。
   */
  localPort?(): number;
  send(data: Uint8Array, port: number, address: string): void;
  close(): void;
  /** 收到一个包。 */
  onMessage(handler: (data: Uint8Array, from: { address: string; port: number }) => void): void;
  /** 套接字错误。 */
  onError(handler: (error: Error) => void): void;
}

/** 编解码能力。native 侧实现；测试里可以换成恒等变换。 */
export interface CallAudioCodec {
  open(): Promise<void>;
  /** 640 字节 PCM → Opus。 */
  encode(pcm: Uint8Array): Promise<Uint8Array>;
  /** Opus → 640 字节 PCM。 */
  decode(opus: Uint8Array): Promise<Uint8Array>;
  close(): void;
}

/**
 * 视频编码能力（H.265）。由主进程注入，`CallSession` 只负责打包与发。
 *
 * 之所以做成回调而不是内置：H.265 编码要么用系统 `ffmpeg` / `x265`，要么走
 * 浏览器的 WebCodecs（在渲染进程里），两条路的生命周期管理完全不同。会话层
 * 只关心「给我一帧 Annex B」。
 */
export interface CallVideoEncoder {
  /**
   * 取下一帧 Annex B 裸流；没有新画面时返回 null（不发包）。
   *
   * 采集在渲染层（WebRTC 拿摄像头），编码在主进程（native `t265`）——
   * 两者之间靠 {@link pushFrame} 连起来：渲染层把 I420 推进队列，
   * 编码器在 `next()` 里取一帧编码。
   */
  next(): Promise<Uint8Array | null>;
  /** 渲染层推来一帧 I420（Y 全尺寸、U/V 各四分之一）。 */
  pushFrame?(frame: { y: Uint8Array; u: Uint8Array; v: Uint8Array }): void;
  /** 视频规格（写进 SPS，供对端初始化）。 */
  info(): VideoStreamInfo;
  /** 待编码的帧数（调试用）。 */
  readonly pendingFrameCount?: number;
  close(): void;
}

/** 借凭据发信令的最小表面（`@weq/protocol` 的实现直接满足）。 */
export interface CallSignaling {
  start(params: {
    selfUid: string;
    peerUid: string;
    media?: 'audio' | 'video';
  }): Promise<{ room: CallRoom; authToken: number }>;
  end(params: { selfUid: string; roomId: bigint; relationId: number }): Promise<void>;
}

/** 定时器，单测里换成手动推进的实现。 */
export interface CallTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export const realTimers: CallTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** 监听器。 */
export type CallListener = (snapshot: CallSnapshot) => void;
/** 收到一帧对端音频（已解码成 PCM）。 */
export type CallAudioListener = (pcm: Uint8Array, at: number) => void;
/**
 * 收到一帧对端视频（已组装成完整帧，裸流通过 `hevc` 给出）。
 *
 * `hevc` 是 Annex B 裸流（含起始码），可直接喂给解码器；为 null 表示这一帧的
 * 载荷不是可识别的 H.265（加密或损坏），调用方应当跳过。
 */
export type CallVideoListener = (frame: VideoFramePayload, at: number) => void;

export interface VideoFramePayload {
  gidx: number;
  fidx: number;
  /**
   * 16 位帧序号 `((fidx - 1) << 8) | gidx`。
   *
   * **不要再用 `fidx` 判层**：`fidx` 是帧序号高字节（每 256 帧 +1），不是 SVC
   * 层号。早先按 `fidx === 1` 过滤「增强层」，导致第 256 帧之后画面永久冻结。
   */
  frameIndex: number;
  isKeyframe: boolean;
  /** 真实帧时间戳（毫秒）。 */
  timestamp: number;
  /** 视频规格（只在关键帧上更新）。 */
  info: VideoStreamInfo | null;
  /** Annex B 裸流；不可识别时为 null。 */
  hevc: Uint8Array | null;
}

export interface CallSessionOptions {
  selfUin: string;
  selfUid: string;
  peerUin: string;
  peerUid: string;
  /** 通话媒体类型。默认 audio。 */
  media?: 'audio' | 'video';
  signaling: CallSignaling;
  transport: UdpTransport;
  codec: CallAudioCodec;
  /** 视频编码器。不给则只做接收（看不到本端画面）。 */
  videoEncoder?: CallVideoEncoder;
  /**
   * 禁止 P2P 直连，媒体全程走服务端中继。
   *
   * 排障开关（设置项 `callDisableP2P`）。置位后：
   *
   * - 不学对端直连地址，也就不会进入 `probing` / `direct`；
   * - {@link mediaTargets} 永远只返回 GCS；
   * - 已有的 `peerDirect` 不再被发送路径使用。
   *
   * 2026-10-28 实测背景：P2P 直连上行只有 7.5 fps / 208 kbps，而经服务端中继
   * 下发的对端流有满 12 fps / 679 kbps —— 直连不一定更快，取决于两端 NAT 与链路。
   */
  disableP2P?: boolean;
  timers?: CallTimers;
  logger?: Logger;
}

// ─────────────────────────── 常量 ───────────────────────────

/** 心跳周期：GCS 按 2 秒判活，缺两拍就拆房间。 */
const HEARTBEAT_MS = 2000;
/** 状态上报周期：不报会被判掉线。 */
const STATUS_REPORT_MS = 2000;
/** 质量反馈周期。 */
const QFB_MS = 2000;
/** 中继保活周期。 */
const RELAY_KEEPALIVE_MS = 5000;
/** 一帧音频 20 ms。 */
const FRAME_MS = 20;
/** 从发起到对端有响应的上限。 */
const RING_TIMEOUT_MS = 60_000;
/** 已进入房间但迟迟不送音频的上限。 */
const CONNECT_TIMEOUT_MS = 30_000;
/** 登出包重发次数（UDP 无连接，单发丢包会让对端停在通话中）。 */
const LOGOUT_REPEATS = 5;

/** 每 4 帧音频一组 RS 编码。 */
const FEC_GROUP = 4;
/** 视频保活周期（实测 2 秒）。 */
const VIDEO_KEEPALIVE_MS = 2000;
/** 同一拍里第二条保活包相对第一条的延迟（实测 40–90 ms）。 */
const VIDEO_KEEPALIVE_SECOND_MS = 60;
/** 视频发送轮询间隔：比最慢的帧间隔（10 fps）小一个量级。 */
const VIDEO_PUMP_MS = 10;
/**
 * 多久没收到对端视频包就认定它停了。
 *
 * 实测帧间隔最大约 200 ms（10 fps 且抖动大），留 3 秒余量 —— 既不会被
 * 正常的卡顿误判，又能在控制包丢失时较快收敛。
 */
const VIDEO_SILENCE_MS = 3000;

/**
 * 学到对端直连地址后，双发探测期长度。
 *
 * 真实客户端是「先纯中继约 8 秒 → 硬切 P2P」，我们没法确定对端此刻是否已经
 * 打通，所以先两种路径同时发一小段，确认直连有回程再停掉服务端那份。
 */
const MEDIA_PROBE_MS = 1000;

/** 直连模式下多久没收到对端媒体包就回落服务端。 */
const MEDIA_DIRECT_TIMEOUT_MS = 2000;

/** P2P 握手（`0x02` ch=1）周期。实测真实客户端是 2 秒一拍。 */
const PEER_PROBE_MS = 2000;

/** 媒体包的发送路径。 */
export type MediaPath = 'server' | 'probing' | 'direct';

// ─────────────────────────── 会话 ───────────────────────────

/**
 * 两个地址是否指向同一台主机（忽略 IPv4 的 IPv6 映射前缀）。
 *
 * udp6 双栈 socket 上，IPv4 来源在 `rinfo.address` 里是 `::ffff:a.b.c.d`，而
 * 服务器表里是 `a.b.c.d`。直接字符串比较会漏判 —— 见 `rememberPeerSource` 的
 * 注释，这个漏判会让服务器回包被当成对端直连地址，媒体退化成全程中继。
 */
function sameHost(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeHost(a) === normalizeHost(b);
}

/** 去掉 IPv4-mapped IPv6 前缀并转小写（IPv6 十六进制大小写不敏感）。 */
function normalizeHost(address: string): string {
  const lower = address.toLowerCase();
  const mapped = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;
  // `::ffff:1.2.3.4` 去掉前缀就是点分 IPv4；但 `::ffff:0102:0304` 形态要去前缀后
  // 再按 IPv6 比较 —— 这里只处理点分那种（Node 在双栈 socket 上就给点分）。
  return mapped;
}

/**
 * 16 字节 IPv6 → 标准文本形式。
 *
 * 通话服务端下发的是裸 16 字节（不是字符串），要转成 `dgram.send` 认的写法。
 * 用 `::` 压缩连续零段，否则 `240e:399:f9d:3f10:0:0:0:1` 这种写法虽然合法，
 * 但和抓包里的形态对不上，排查时会误以为地址不同。
 */
function formatIpv6(raw: Uint8Array): string | null {
  if (raw.length !== 16) return null;
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((raw[i]! << 8) | raw[i + 1]!);

  // 找最长的一段连续 0（RFC 5952：至少两个零组才压缩）。
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (runStart < 0) {
        runStart = i;
        runLen = 0;
      }
      runLen++;
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
    } else {
      runStart = -1;
      runLen = 0;
    }
  }

  const hex = (n: number) => n.toString(16);
  if (bestLen < 2) return groups.map(hex).join(':');
  const head = groups.slice(0, bestStart).map(hex).join(':');
  const tail = groups
    .slice(bestStart + bestLen)
    .map(hex)
    .join(':');
  return `${head}::${tail}`;
}

/**
 * fixed32 → 点分 IPv4。
 *
 * `parsePb` 的 `fixed32` 是「按 wire 上的字节顺序读成的大端数」，所以直接按字节
 * 拆就是网络序的 IPv4：线上 `b7 2f 69 f0` → 183.47.105.240（`bt=9` 的 `f5`
 * 与服务器表的 `ip` / `altIp` 都是这个约定）。
 */
function formatIpv4Fixed(value: number): string {
  const n = value >>> 0;
  return `${(n >>> 24) & 0xff}.${(n >>> 16) & 0xff}.${(n >>> 8) & 0xff}.${n & 0xff}`;
}

/**
 * 从一帧 Annex B 里读 HEVC 规格（分辨率 / profile）。
 *
 * 只在关键帧上调：IDR 前面带 VPS + SPS + PPS，SPS 里有分辨率。实测视频流
 * 640×360 Main。解析失败返回 null —— 规格只是给界面显示的，读不到不影响解码。
 *
 * SPS 的字段顺序（HEVC）：NAL 头 2 字节之后是
 * `sps_video_parameter_set_id`(4b) + `sps_max_sub_layers_minus1`(3b) +
 * `sps_temporal_id_nesting_flag`(1b) = 1 字节，再往后是
 * `profile_tier_level`(12B)，然后才是 `sps_seq_parameter_set_id`、
 * `chroma_format_idc`（==3 时多一个 `separate_colour_plane_flag`）、
 * `pic_width_in_luma_samples`、`pic_height_in_luma_samples`，都是 Exp-Golomb。
 *
 * ⚠️ 偏移是 **13 字节**不是 12：早先按 12 字节跳，等于把
 * `temporal_id_nesting_flag` 当成了 `sps_seq_parameter_set_id` 的首位，读出来的
 * 是 `chroma=0 / width=0 / height=1`，于是这个函数**永远返回 null**（界面拿不到
 * 分辨率）。另外必须先剥掉 emulation prevention byte（`00 00 03` → `00 00`），
 * 否则一旦载荷里出现该序列，位流整体错位。
 */
function readHevcInfo(annexb: Uint8Array): VideoStreamInfo | null {
  for (const nal of splitHevcNals(annexb)) {
    // SPS = 33。NAL 头 2 字节，之后是 RBSP。
    if (nal.type !== 33 || nal.data.length < 16) continue;
    const profile = nal.data[1]!; // profile_idc 在 NAL 头的第二个字节
    const rbsp = removeEmulationPrevention(nal.data.subarray(2));
    if (rbsp.length < 13) continue;
    const bits = new BitReader(rbsp.subarray(13));
    try {
      bits.ue(); // sps_seq_parameter_set_id
      const chroma = bits.ue();
      if (chroma === 3) bits.u(1); // separate_colour_plane_flag
      const width = bits.ue();
      const height = bits.ue();
      if (width > 0 && height > 0 && width < 16384 && height < 16384) {
        return { width, height, profile, codec: 'hevc' };
      }
    } catch {
      // 位读越界：这帧的 SPS 不完整，交给下一个关键帧。
    }
  }
  return null;
}

/**
 * 剥掉 NAL 载荷里的 emulation prevention byte。
 *
 * H.264/H.265 规定 RBSP 里出现 `00 00 00/01/02/03` 时，编码端在第二个 `00`
 * 之后插一个 `03` 防止与起始码混淆。解析位流前必须先把这些 `03` 去掉。
 */
function removeEmulationPrevention(data: Uint8Array): Uint8Array {
  // 绝大多数 NAL 不含该序列，先扫一遍，没有就零拷贝返回。
  let has = false;
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      has = true;
      break;
    }
  }
  if (!has) return data;
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    if (i + 2 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out[n++] = 0;
      out[n++] = 0;
      i += 2; // 跳过被插入的 03
      continue;
    }
    out[n++] = data[i]!;
  }
  return out.subarray(0, n);
}

/** 极简位读取器，只够解析 SPS 的前几个 Exp-Golomb 字段。 */
class BitReader {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  /** 读 n 位。 */
  u(n: number): number {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.data[this.pos >> 3];
      if (byte === undefined) throw new Error('位读越界');
      value = (value << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return value;
  }

  /** 无符号 Exp-Golomb。 */
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      zeros++;
      if (zeros > 32) throw new Error('Exp-Golomb 过长');
    }
    if (zeros === 0) return 0;
    return (1 << zeros) - 1 + this.u(zeros);
  }
}

export class CallSession {
  private readonly opts: CallSessionOptions;
  private readonly timers: CallTimers;
  private readonly log: Logger | undefined;

  private state: CallState = 'idle';
  private room: CallRoom | null = null;
  private authToken = 0;
  private relationId = 0;
  /** 认证回包里的会话时间戳，之后所有包的 head.f3 都用它。 */
  private sessionTs = 0;
  /** 全局递增的 typeId。 */
  private typeId = GCS_TYPE_ID_BASE;

  private gcs: CallServer | null = null;
  private relays: CallServer[] = [];

  private startedAt: number | null = null;
  private connectedAt: number | null = null;
  private endReason: CallEndReason | null = null;
  private lastError: string | null = null;
  private sentFrames = 0;
  private receivedFrames = 0;

  // 视频
  private readonly videoAssembler = new VideoFrameAssembler();
  private videoSending = false;
  private videoReceiving = false;
  private receivedVideoFrames = 0;
  /** 最后一帧视频到达的时刻（毫秒），用于「对端静默停流」的兜底判断。 */
  private lastVideoPacketAt = 0;
  /** 最后一个控制包到达的时刻（毫秒）。控制包是周期公告，不是开关边沿。 */
  private lastVideoControlAt = 0;
  /**
   * 对端的直连地址（P2P）。
   *
   * 地址由 GCS 的 `bt=9` 下发（body.f7 = 16 字节 IPv6），端口只能从对端实际
   * 发包的来源学到（见 {@link rememberPeerSource}）。
   */
  private peerDirect: { address: string; port: number } | null = null;
  /** 最近一次收到对端包的来源（P2P 端口往往只能从实际流量里学到）。 */
  private lastPeerFrom: { address: string; port: number } | null = null;
  /**
   * 服务端在 `bt=27` 里下发的对端 P2P 端口。
   *
   * `bt=9` 的 `f8` 只是个近似值（实测 56082 vs 真实 56089），`bt=27` 才是权威。
   * 地址仍然要靠 `bt=9`（f7 IPv6 / f5 IPv4），两边拼起来才是完整端点。
   */
  private peerAnnouncedPort: number | null = null;
  /**
   * 本端 UDP 套接字的本地端口。
   *
   * `bt=25` 要向服务端公告它，服务端再转给对端 —— 这是 P2P 能建立的开关。
   */
  private localPort = 0;
  /** 已发出的 `bt=25` 条数（避免无限制重发）。 */
  private peerJoinReports = 0;
  /** 本端控制包序号（中继 GET_IN 与 P2P 握手共用一条计数，实测如此）。 */
  private peerPacketSeq = 20_000 + Math.floor(Math.random() * 40_000);
  /** 中继通道的序号（同一通内恒定，GET_IN 与保活共用）。 */
  private relaySeq = 0;
  /** 对端回过我们的 P2P 握手应答（说明双向可达）。 */
  private peerProbeAnswered = false;
  /** P2P 握手的定时器。 */
  private peerProbeTimer: unknown = null;
  /**
   * 媒体走哪条路。
   *
   * 真实客户端不是双发，而是**先纯中继、后硬切 P2P**（实测 0–7.9 秒只发服务端，
   * 之后只发对端直连，服务端一个包都收不到）。我们沿用这个顺序，但切换点必须
   * 由**回程证据**决定，不能由「拿到了一个地址」决定 —— 见
   * {@link confirmPeerPath} 与 {@link applyPeerEndpoint}。
   */
  private mediaPath: MediaPath = 'server';
  /** 进入 `probing` 的时刻（毫秒）。 */
  private probeSince = 0;
  /** 最近一次收到对端媒体包的时刻（毫秒），直连回落用。 */
  private lastPeerMediaAt = 0;
  /** 已见过的媒体子类型（每个只记一次日志，避免逐包刷屏）。 */
  private readonly seenMediaSubTypes = new Set<number>();
  /** 是否已发过视频流状态协商首包（`bt=31/f1=3`）。 */
  private videoStateStarted = false;
  /**
   * 进入 `probing` 的时刻，用于「探测期满仍无回程」的强制回落。
   *
   * 与 {@link probeSince} 分开：`probeSince` 决定什么时候从 probing 推进，
   * 这里只用来兜底判死。两者同源但语义不同，合在一起会让「重置探测期」
   * 把兜底计时也一起清掉。
   */
  private probeDeadlineAt = 0;
  /** 媒体路径看门狗。 */
  private mediaWatchdogTimer: unknown = null;
  /** 已发出的视频帧数。 */
  private sentVideoFrames = 0;
  /** 连续取不到帧的轮数（用于只报一次警）。 */
  private videoStarvedTicks = 0;
  private videoInfo: VideoStreamInfo | null = null;
  /** 视频帧序号（写进 sub-header，每帧 +1）。 */
  private videoFrameIndex = 0;
  /** 视频分片序号（每片 +1，整通不重置）。 */
  private videoSeq = 0;
  /**
   * 写进 sub-header `[16:20]` 的小整数。
   *
   * 实测真机取 0–4，且和 `total_pkg` 没有固定关系（对不上 `total_pkg-1`）。
   * 目前按 `帧内分片数 - 1` 生成 —— 落点与实测分布一致，对端也不解析它。
   */
  private videoFrameFragment = 0;
  /**
   * 对端视频流的时间基准，写进本端 sub-header 的 `[12:16]`。
   *
   * 实测（2026-10-26 抓包）：对端还没开始发视频时填 0；收到对端首个视频帧后，
   * 填**该帧 `[8:12]` 的值**，之后整通不变。语义是「我跟对端的哪个时间基准
   * 对齐」，不是本端接通的 tick —— 早期填 `this.tick()` 是错的。
   */
  private peerVideoBase = 0;
  /** 本端接通的 tick（保留给日志 / 调试，不再写进 sub-header）。 */
  private mediaBaseTick = 0;
  /** 视频保活定时器。 */
  private videoKeepaliveTimer: unknown = null;
  /** 视频发送循环定时器。 */
  private videoTimer: unknown = null;
  /** 视频接收看门狗。 */
  private videoWatchdogTimer: unknown = null;
  /** 本端视频编码器（由主进程注入；没有就只做接收）。 */
  private videoEncoder: CallVideoEncoder | null = null;
  /** 本端画面来源。协议层不区分，只透传给界面。 */
  private videoSource: CallVideoSource = 'camera';

  // 定时器
  private heartbeatTimer: unknown = null;
  private statusTimer: unknown = null;
  private qfbTimer: unknown = null;
  private relayTimer: unknown = null;
  private audioTimer: unknown = null;
  private ringTimer: unknown = null;
  private connectTimer: unknown = null;

  // 音频
  private readonly sendQueue: Uint8Array[] = [];
  private audioSeq = 0;
  private frameCounter = 0;
  private sampleBase = 0;
  private statusReportSeq = 0;
  private qfbSeq = 0;
  /** 上一组音频的 RS 校验行 + 帧长 + 锚帧 tick。 */
  private fecParity: Uint8Array[] | null = null;
  private fecPaySize = 0;
  private fecGroupTick = 0;
  private fecGlobalCnt = 0;
  private fecSubSeq = 1000 + Math.floor(Math.random() * 9000);

  /** 对方最后一个包的 tick（质量反馈的 tsStart）。 */
  private lastPeerTick = 0;

  private readonly listeners = new Set<CallListener>();
  private readonly audioListeners = new Set<CallAudioListener>();
  private readonly videoListeners = new Set<CallVideoListener>();

  constructor(options: CallSessionOptions) {
    this.opts = options;
    this.timers = options.timers ?? realTimers;
    this.log = options.logger;
    this.videoEncoder = options.videoEncoder ?? null;
  }

  // ── 对外 ──

  snapshot(): CallSnapshot {
    return {
      state: this.state,
      roomId: this.room?.roomId.toString() ?? null,
      peerUin: this.opts.peerUin,
      peerUid: this.opts.peerUid,
      startedAt: this.startedAt,
      connectedAt: this.connectedAt,
      endReason: this.endReason,
      lastError: this.lastError,
      sentFrames: this.sentFrames,
      receivedFrames: this.receivedFrames,
      videoSending: this.videoSending,
      videoReceiving: this.videoReceiving,
      receivedVideoFrames: this.receivedVideoFrames,
      videoInfo: this.videoInfo,
      videoSource: this.videoSource,
      videoProfile: this.localVideoProfile(),
    };
  }

  /**
   * 本端当前编码档位。
   *
   * 以注入的编码器为准（它会随采集源切换而换档），没有编码器时返回 null ——
   * 那种情况下只发控制信令、不画面。
   */
  private localVideoProfile(): CallVideoEncoding | null {
    const encoder = this.videoEncoder;
    if (!encoder) return null;
    const info = encoder.info();
    return {
      width: info.width,
      height: info.height,
      fps: info.fps ?? 0,
      bitrateKbps: info.bitrateKbps ?? 0,
    };
  }

  /**
   * 更新本端采集源与编码档位（摄像头 ↔ 屏幕共享）。
   *
   * 协议层**什么都不发**：屏幕共享与摄像头在协议上是同一路主视频流。这里只是
   * 把状态记下来，让 `snapshot()` 能告诉界面「当前在共享屏幕、编码尺寸是多少」。
   */
  setVideoSource(source: CallVideoSource): void {
    if (this.videoSource === source) return;
    this.videoSource = source;
    this.log?.info('本端视频采集源', { source, profile: this.localVideoProfile() });
    this.emit();
  }

  /**
   * 编码档位变了（换采集源 / 按源宽高比重设尺寸）时刷新规格。
   *
   * `snapshot().videoProfile` 与界面都从这里取；编码器本身由主进程重开，
   * 这里只负责让状态对得上。
   */
  setVideoEncoding(): void {
    this.log?.info('本端视频规格更新', { profile: this.localVideoProfile() });
    this.emit();
  }

  onStateChange(listener: CallListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onAudio(listener: CallAudioListener): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  /** 收到一帧对端视频（已组装、已剥掉 sub-header 的 H.265 裸流）。 */
  onVideo(listener: CallVideoListener): () => void {
    this.videoListeners.add(listener);
    return () => this.videoListeners.delete(listener);
  }

  /**
   * 开 / 关本端摄像头。
   *
   * 协议上**没有**「开」和「关」两种包：两者都是同一条空体 `subType=4`，
   * 连发两次防丢包。所以这里只做「发控制包 + 切换本端发送状态」。
   *
   * 打开后真正发画面要等 `videoEncoder` 吐帧（见 {@link pumpVideo}）；
   * 没有注入编码器时只发控制包，对端会显示「等待对方画面」。
   */
  setCamera(enabled: boolean): void {
    this.log?.info('setCamera 请求', {
      enabled,
      state: this.state,
      current: this.videoSending,
      hasGcs: Boolean(this.gcs),
      sessionTs: this.sessionTs,
    });
    if (this.state !== 'connected') {
      this.log?.warn('setCamera 被拒：通话未接通', { state: this.state });
      return;
    }
    if (this.videoSending === enabled) {
      this.log?.warn('setCamera 被拒：状态已是目标值', { enabled });
      return;
    }
    this.videoSending = enabled;
    if (enabled) this.startVideoState();
    this.sendVideoControl();
    if (enabled) {
      this.videoFrameIndex = 0;
      this.startVideoLoop();
      this.startVideoKeepalive();
    } else {
      this.stopVideoLoop();
    }
    this.log?.info('摄像头状态', { enabled });
    this.emit();
  }

  /** 把一帧 640 字节 PCM 排进发送队列。队列空的时候发静音帧。 */
  pushAudio(pcm: Uint8Array): void {
    if (pcm.length !== FRAME_SAMPLES * 2) return;
    if (this.state !== 'connected') return;
    // 最多压 5 帧（100 ms）：落后太多说明前端卡了，丢掉旧的保持实时。
    if (this.sendQueue.length > 5) this.sendQueue.shift();
    this.sendQueue.push(pcm);
  }

  /** 发起通话。 */
  async start(): Promise<CallSnapshot> {
    if (this.state !== 'idle') throw new Error(`通话已在 ${this.state} 状态`);
    this.startedAt = this.timers.now();

    try {
      // 1. 信令
      const { room, authToken } = await this.opts.signaling.start({
        selfUid: this.opts.selfUid,
        peerUid: this.opts.peerUid,
        media: this.opts.media ?? 'audio',
      });
      this.room = room;
      this.authToken = authToken;
      this.relationId = room.relationId;
      this.pickServers(room.servers);
      if (!this.gcs) throw new Error('服务端没有返回可用的服务器地址');

      // 2. 编解码器
      await this.opts.codec.open();

      // 3. UDP
      this.opts.transport.onMessage((data, from) => this.handlePacket(data, from));
      this.opts.transport.onError((error) => this.fail(error.message));
      await this.opts.transport.bind();
      // P2P 端点公告要用这个端口（见 sendPeerJoinReport）。
      this.localPort = this.opts.transport.localPort?.() ?? 0;

      // 4. 握手
      this.sendAuth();
      this.startHeartbeat();
      this.startStatusReport();
      this.sendCodecInit();

      this.state = 'calling';
      this.emit();
      this.armRingTimeout();
      return this.snapshot();
    } catch (error) {
      // 这里必须**等**收尾走完才返回：`teardown` 是异步的，而终点状态
      // （`failed`）在它末尾才落下。不 await 的话调用方拿到的快照还是
      // `idle`，看起来像「什么都没发生」。
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.log?.error('通话失败', { error: message });
      await this.teardown('error');
      return this.snapshot();
    }
  }

  /** 主动挂断。 */
  async hangup(reason: CallEndReason = 'hangup'): Promise<void> {
    if (this.state === 'idle' || this.state === 'ended' || this.state === 'failed') return;
    if (this.state !== 'ending') {
      this.state = 'ending';
      this.emit();
    }
    await this.teardown(reason);
  }

  // ── 服务器选择 ──

  /**
   * 选 GCS：**按端口优先，组内保持服务端下发的原始顺序**。
   *
   * `type` 不能用来区分 GCS：QQ 本体实际连接的 `8000` 也经常标成 `type=2`。
   * 真正可靠的是端口：`8000` / `8001` 是 GCS，`8800` 是中继。
   *
   * 2026-10-26 关闭 TUN 后的对照抓包：
   *
   * - WeQ 按原始顺序选中 `240e:930:c200:8a::1c:8800`，`bt=9` 只给 IPv4
   *   `f5/f6`；WeQ 向该端点打洞、发媒体，对端始终不回包；
   * - QQ 本体连接 `8000`，`bt=9` 给出对端 IPv6 `f7/f8`，随后 P2P 正常。
   *
   * 因此先试所有 `8000` / `8001`，全部失败再回退其余端口。组内仍保持服务端
   * 原始顺序，并优先复用上次认证成功的 GCS IP。
   */
  private pickServers(servers: CallServer[]): void {
    const isGcsPort = (server: CallServer) => server.port === 8000 || server.port === 8001;
    const preferred = servers.filter(isGcsPort);
    const fallback = servers.filter((server) => !isGcsPort(server));
    this.gcsCandidates = [...preferred, ...fallback];
    this.gcs =
      preferred.find((s) => s.ip === CallSession.goodGcsIp) ??
      preferred[0] ??
      this.gcsCandidates.find((s) => s.ip === CallSession.goodGcsIp) ??
      this.gcsCandidates[0] ??
      null;
    this.gcsIndex = Math.max(0, this.gcsCandidates.indexOf(this.gcs!));
    this.log?.debug('服务器表', {
      total: servers.length,
      ipv6: servers.filter((s) => s.ip.includes(':')).length,
      gcsPorts: preferred.length,
      picked: this.gcs ? `${this.gcs.ip}:${this.gcs.port}` : 'none',
    });

    // 中继通道注册用前两台（按原始顺序，去重）。
    const seen = new Set<string>();
    this.relays = [];
    for (const server of servers) {
      const key = `${server.ip}:${server.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.relays.push(server);
      if (this.relays.length >= 2) break;
    }
  }

  /** 候选 GCS 地址，按尝试顺序。 */
  private gcsCandidates: CallServer[] = [];
  /**
   * 进程内记住上次认证成功的 GCS **IP**（端口每次会变，不能整条复用）。
   *
   * 服务端每次分配的机器在一小撮里轮换，可达的那几台通常一直可达 —— 记住它
   * 能省掉首次的 3 秒探测。
   */
  private static goodGcsIp: string | null = null;
  /** 当前在第几台候选上。 */
  private gcsIndex = 0;
  /** 切换 GCS 的定时器。 */
  private gcsRetryTimer: unknown = null;
  /** 本轮是否已收到认证回包。 */
  private authAcked = false;

  // ── 发包 ──

  private send(data: Uint8Array): void {
    if (!this.gcs) return;
    this.opts.transport.send(data, this.gcs.port, this.gcs.ip);
  }

  /** 媒体包该发给谁（`sendMedia` 与延迟重发共用）。 */
  private mediaTargets(): Array<{ address: string; port: number }> {
    const out: Array<{ address: string; port: number }> = [];
    if (!this.gcs) return out;
    const peer = this.peerDirect;
    const hasPeer = peer !== null && peer.port > 0;

    // probing → direct 的推进放在这里惰性做：音频 20 ms 一帧、保活 2 秒一条都会
    // 走到这条路径，摄像头关着也不会卡在 probing。
    //
    // ⚠️ **探测期满不等于直连可用。** 旧实现到期就无条件切 `direct`，只要拿到
    // 一个「看起来像对端」的地址（中继下发的、bt=9 的 IPv4 近似值……）就切，
    // 切完服务端一个包都收不到，而那个地址可能根本不回包 —— 2026-10-26 实测
    // 三个候选（中继:19341 / 11.149.189.80:8889 / 中继:19338）全是零回程，
    // 对端于是完全收不到我们的流，报「对方网络质量不佳」。
    //
    // 现在的判据是**回程证据**（{@link confirmPeerPath} 置位）：
    // 探测期满仍无回程 → 直接放弃这一轮，退回 `server` 并清掉端口等重新学习。
    if (this.mediaPath === 'probing' && this.timers.now() - this.probeSince >= MEDIA_PROBE_MS) {
      if (hasPeer && this.peerProbeAnswered) {
        this.mediaPath = 'direct';
        this.log?.info('媒体路径切换', { path: this.mediaPath });
      } else {
        this.log?.warn('探测期满无直连回程，保持中继', {
          address: peer?.address,
          port: peer?.port,
          answered: this.peerProbeAnswered,
        });
        this.mediaPath = 'server';
        this.probeDeadlineAt = 0;
        // 端口归零、地址留着：等对端下次真的发包过来再重新学。
        if (this.peerDirect) this.peerDirect = { address: this.peerDirect.address, port: 0 };
        this.lastPeerFrom = null;
      }
    }
    // 兜底：探测期被反复重置（对端零星发包）时，超过 3 倍探测期仍无回程也判死。
    if (this.mediaPath === 'probing' && this.probeDeadlineAt > 0) {
      if (
        this.timers.now() - this.probeDeadlineAt >= MEDIA_PROBE_MS * 3 &&
        !this.peerProbeAnswered
      ) {
        this.log?.warn('直连探测超时，放弃本轮 P2P', { address: peer?.address });
        this.mediaPath = 'server';
        this.probeDeadlineAt = 0;
        if (this.peerDirect) this.peerDirect = { address: this.peerDirect.address, port: 0 };
        this.lastPeerFrom = null;
      }
    }

    // 禁用 P2P：媒体永远只发 GCS。放在这里而不是 `applyPeerEndpoint` 一处，
    // 是因为 `mediaPath` 可能被三条路径改成 probing/direct（bt=27、真实回程、
    // 中继候选），逐个挡住容易漏；出口只有这一个。
    const wantServer = this.opts.disableP2P || this.mediaPath !== 'direct';
    const wantPeer = !this.opts.disableP2P && hasPeer && this.mediaPath !== 'server';
    if (wantServer) out.push({ address: this.gcs.ip, port: this.gcs.port });
    if (wantPeer && peer) {
      // 同一台机器（回环 / 服务端与对端同址）会撞上，避免重复发。地址比较要做
      // IPv4 映射归一化，否则 `::ffff:1.2.3.4` 与 `1.2.3.4` 会被当成两台机器，
      // 同一份媒体包连发两遍。
      if (!sameHost(peer.address, this.gcs.ip) || peer.port !== this.gcs.port) {
        out.push({ address: peer.address, port: peer.port });
      }
    }
    return out;
  }

  /**
   * 发媒体包（`0x5b`），按 {@link mediaPath} 决定去向。
   *
   * 真实客户端**不是双发**：0–7.9 秒只发服务端（中继），之后只发对端直连，
   * 切换后服务端一个包都收不到。我们照这个顺序走：
   *
   * - `server`：只发 GCS。还没学到对端端口时就是这一档。
   * - `probing`：两份都发，持续 {@link MEDIA_PROBE_MS}，确认直连有回程。
   * - `direct`：只发对端直连。
   *
   * 直连静默超时后由 {@link startMediaWatchdog} 打回 `server`。
   */
  private sendMedia(data: Uint8Array): void {
    for (const target of this.mediaTargets()) {
      this.opts.transport.send(data, target.port, target.address);
    }
  }

  private sendTo(data: Uint8Array, server: CallServer): void {
    this.opts.transport.send(data, server.port, server.ip);
  }

  private nextTypeId(): number {
    return ++this.typeId;
  }

  private tick(): number {
    return this.timers.now() >>> 0;
  }

  private sendAuth(): void {
    if (!this.room || !this.gcs) return;
    const packet = buildGcsAuth({
      roomId: this.room.roomId,
      selfUin: Number(this.opts.selfUin),
      typeId: GCS_TYPE_ID_BASE,
      authKey: this.room.authKey,
      capabilities: DEFAULT_CAPABILITIES,
    });
    this.authAcked = false;
    // 真实客户端连发两次；服务端对重复认证是幂等的。
    this.send(packet);
    this.send(packet);
    this.armGcsProbe();
  }

  /**
   * 3 秒内没等到认证回包就换下一台 GCS。
   *
   * 服务端给的地址里总有一两台是当前网络到不了的（跨运营商 / IPv6-only 的
   * 备用地址）。真实客户端会并行试多个，我们串行试 —— 3 秒足够一次 RTT，
   * 又不会让用户等太久。
   */
  private armGcsProbe(): void {
    this.clearGcsRetry();
    this.gcsRetryTimer = this.timers.setTimeout(() => {
      this.gcsRetryTimer = null;
      if (this.authAcked) return;
      if (this.gcsIndex + 1 >= this.gcsCandidates.length) {
        // 全部试过还是不通：留着当前这台继续心跳，可能是回包慢。
        this.log?.warn('所有 GCS 候选都没有认证回包');
        return;
      }
      this.gcsIndex++;
      this.gcs = this.gcsCandidates[this.gcsIndex]!;
      this.log?.debug('切换 GCS', { ip: this.gcs.ip, port: this.gcs.port });
      this.sendAuth();
      this.sendRelayGetIn();
      this.sendCodecInit();
    }, 3000);
  }

  private clearGcsRetry(): void {
    if (this.gcsRetryTimer !== null) {
      this.timers.clearTimeout(this.gcsRetryTimer);
      this.gcsRetryTimer = null;
    }
  }

  private sendRelayGetIn(): void {
    if (!this.room) return;
    // 序号在同一通内恒定（GET_IN 与保活共用），不能每次重发都换一个。
    if (this.relaySeq === 0) this.relaySeq = this.nextPeerSeq();
    for (const server of this.relays) {
      this.sendTo(
        buildRelayGetIn({
          roomId: this.room.roomId,
          selfUin: Number(this.opts.selfUin),
          peerUin: Number(this.opts.peerUin),
          seq: this.relaySeq,
          authToken: this.authToken,
        }),
        server,
      );
    }
  }

  /** 编码器初始化帧：声明本端用 Opus。 */
  private sendCodecInit(): void {
    this.send(
      buildCodecInitFrame({
        sessionTs: this.sessionTs,
        tick: this.tick(),
      }),
    );
    // 顺带发几帧静音，让对端的解码器立刻有数据可吃。
    for (let i = 0; i < 4; i++) this.sendSilenceFrame();
  }

  private sendSilenceFrame(): void {
    if (!this.room) return;
    this.audioSeq++;
    this.frameCounter++;
    const sampleCounter = this.sampleBase + this.frameCounter * FRAME_SAMPLES;
    const { packet } = buildAudioFrame({
      seq: this.audioSeq,
      sessionTs: this.sessionTs,
      tick: this.tick(),
      sampleCounter,
      frameCounter: this.frameCounter,
      opus: OPUS_SILENCE,
    });
    this.sendMedia(packet);
    this.sentFrames++;
  }

  // ── 定时器 ──

  private startHeartbeat(): void {
    const beat = () => {
      if (!this.room) return;
      this.send(
        buildGcsHeartbeat({
          roomId: this.room.roomId,
          selfUin: Number(this.opts.selfUin),
          typeId: this.nextTypeId(),
          sessionTs: this.sessionTs,
          tick: this.tick(),
        }),
      );
    };
    beat();
    this.heartbeatTimer = this.timers.setInterval(beat, HEARTBEAT_MS);
  }

  private startStatusReport(): void {
    this.statusTimer = this.timers.setInterval(() => {
      if (!this.room) return;
      this.statusReportSeq++;
      const videoCall = this.opts.media === 'video' || this.videoSending;
      this.send(
        buildStatusReport({
          roomId: this.room.roomId,
          selfUin: Number(this.opts.selfUin),
          sessionTs: this.sessionTs,
          typeId: this.nextTypeId(),
          sendPackets: this.sentFrames,
          recvPackets: this.receivedFrames,
          sendBytes: this.sentFrames * 80,
          seq: this.statusReportSeq,
          media: videoCall ? 'video' : 'audio',
        }),
      );
    }, STATUS_REPORT_MS);
  }

  private startQfb(): void {
    this.qfbTimer = this.timers.setInterval(() => {
      if (!this.room) return;
      this.qfbSeq++;
      this.send(
        buildQfbRequest({
          seq: this.qfbSeq,
          sessionTs: this.sessionTs,
          tick: this.tick(),
          qfbSeq: this.qfbSeq,
          tsStart: this.lastPeerTick,
        }),
      );
    }, QFB_MS);
  }

  private startRelayKeepalive(): void {
    this.relayTimer = this.timers.setInterval(() => {
      if (!this.room) return;
      for (const server of this.relays) {
        this.sendTo(
          buildRelayKeepalive({
            roomId: this.room.roomId,
            selfUin: Number(this.opts.selfUin),
            peerUin: Number(this.opts.peerUin),
            seq: this.relaySeq,
            authToken: this.authToken,
          }),
          server,
        );
      }
    }, RELAY_KEEPALIVE_MS);
  }

  /**
   * 20 ms 一拍的发送循环。
   *
   * 对齐到绝对时间（`startedAt + n × 20`），而不是「每次 setTimeout(20)」——
   * 后者会被事件循环的调度抖动越拖越慢，20 秒后就能差出好几帧，接收端的
   * jitter buffer 会当成网络抖动去补帧，听起来断续。
   *
   * 单次最多补 2 帧：落后更多说明本机卡了（GC / 休眠），追帧只会把一批音频
   * 瞬间砸过去，不如跳过这段间隙。
   */
  private startAudioLoop(): void {
    let anchor = this.timers.now();
    let emitted = 0;
    const MAX_BURST = 2;

    const pump = () => {
      if (this.state !== 'connected') return;
      const elapsed = this.timers.now() - anchor;
      const due = Math.floor(elapsed / FRAME_MS) + 1;
      let behind = due - emitted;
      if (behind > MAX_BURST) {
        anchor = this.timers.now() - emitted * FRAME_MS;
        behind = Math.floor((this.timers.now() - anchor) / FRAME_MS) + 1 - emitted;
      }
      let burst = 0;
      while (
        emitted < Math.floor((this.timers.now() - anchor) / FRAME_MS) + 1 &&
        burst < MAX_BURST
      ) {
        emitted++;
        burst++;
        void this.emitFrame();
      }
      const nextAt = anchor + emitted * FRAME_MS;
      const delay = Math.max(1, Math.min(18, Math.floor(nextAt - this.timers.now())));
      this.audioTimer = this.timers.setTimeout(pump, delay);
    };
    this.audioTimer = this.timers.setTimeout(pump, 0);
  }

  private async emitFrame(): Promise<void> {
    if (!this.room) return;
    const pcm = this.sendQueue.shift();
    let opus = OPUS_SILENCE;
    if (pcm) {
      try {
        opus = await this.opts.codec.encode(pcm);
      } catch (error) {
        this.log?.warn('编码一帧失败，改发静音', { error });
      }
    }

    this.audioSeq++;
    this.frameCounter++;
    const posInGroup = (this.frameCounter - 1) % FEC_GROUP;

    // 组内前 3 帧携带**上一组**的校验行；第 4 帧是锚帧。
    let fecContainer: Uint8Array | undefined;
    if (posInGroup < FEC_GROUP - 1 && this.fecParity) {
      this.fecGlobalCnt++;
      const cnt0 = this.fecGlobalCnt - 1;
      fecContainer = buildFecContainer({
        parity: this.fecParity[posInGroup]!,
        paySize: this.fecPaySize,
        rowIndex: posInGroup,
        globalCnt: this.fecGlobalCnt,
        groupTick: this.fecGroupTick,
        // 跳过每组锚帧的位置：1,2,3, 5,6,7, 9,10,11…
        globalFecIdx: cnt0 + Math.floor(cnt0 / (FEC_GROUP - 1)) + 1,
        fecSubSeq: this.fecSubSeq,
      });
    }

    const tick = this.tick();
    const sampleCounter = this.sampleBase + this.frameCounter * FRAME_SAMPLES;
    const { packet, rsfec } = buildAudioFrame({
      seq: this.audioSeq,
      sessionTs: this.sessionTs,
      tick,
      sampleCounter,
      frameCounter: this.frameCounter,
      opus,
      fecContainer,
    });
    this.sendMedia(packet);
    this.sentFrames++;

    // 先把第 4 帧入组，校验才能保护完整四帧，而不是只算前三帧。
    this.audioGroup.push(rsfec);
    if (posInGroup === FEC_GROUP - 1) {
      const group = this.audioGroup;
      const maxLen = Math.max(...group.map((f) => f.length), 0);
      if (maxLen > 0) {
        this.fecParity = rsEncode(group, maxLen);
        this.fecPaySize = maxLen;
        this.fecGroupTick = tick;
      }
      this.audioGroup = [];
    }
  }

  /** 当前正在凑的这一组 RS 帧。 */
  private audioGroup: Uint8Array[] = [];

  // ── 收包 ──

  private handlePacket(data: Uint8Array, from: { address: string; port: number }): void {
    if (data.length < 1) return;
    const stx = data[0];
    // 媒体包（0x5b）的来源可能是 P2P 直连 —— 记下它，媒体回程要用。
    if (stx === AUDIO_STX) {
      this.rememberPeerSource(from);
      this.handleAudio(data);
    } else if (stx === GCS_STX) this.handleGcs(data);
    else if (stx === RELAY_STX) this.handleRelay(data, from);
  }

  private handleGcs(data: Uint8Array): void {
    const packet = parseGcsPacket(data);
    if (!packet) return;

    // 认证回包里的会话时间戳，之后所有包都要带。
    if (packet.sessionTs !== 0) this.sessionTs = packet.sessionTs;

    switch (packet.bodyType) {
      case GcsBodyType.authRsp:
        this.handleAuthRsp();
        break;
      case GcsBodyType.notifyPush:
        this.handleCallEvent(packet.body, packet.typeId);
        break;
      case GcsBodyType.peerJoin:
        // bt=27：服务端告知对端真实 P2P 端口（地址在 bt=9 里）。
        this.handlePeerJoin(packet.body);
        this.ackPush(packet.typeId, packet.bodyType, packet.body);
        break;
      case GcsBodyType.ctrlPush:
        // bt=9 带对端直连地址 —— 视频通话的媒体与控制包主要走 P2P，
        // 只发服务端对端收不到。解析完照常 ACK。
        this.handlePeerAddress(packet.body);
        // 对端已经进房：把自己的 P2P 端口公告出去（晚于接通时的那次补一条）。
        this.sendPeerJoinReport(2);
        this.ackPush(packet.typeId, packet.bodyType, packet.body);
        break;
      case GcsBodyType.videoStatePush:
        this.handleVideoStatePush(packet);
        break;
      default:
        // 其它推送类型一律回 ACK：不回的话服务端会重推。
        if (packet.bodyType % 2 === 1) this.ackPush(packet.typeId, packet.bodyType, packet.body);
        break;
    }
  }

  /**
   * 解析 `bt=9` 里的对端直连地址与端口。
   *
   * body 结构（2026-10-26 同一次通话的 OIDB + UDP 抓包对照，QQ 本体 P2P 正常）：
   *
   * ```text
   * f1 bytes(10) 链路描述
   * f2 varint    对端 QQ 号
   * f3 varint    会话相关
   * f7 bytes(16) 对端 IPv6 地址          ★
   * f8 varint    对端 P2P 端口            ★
   * ```
   *
   * 实测（同一次通话）：
   *
   * ```text
   * bt=9: f7 = 240e:399:f9d:3f10:7873:e70f:577e:60c5
   *       f8 = 56082
   * 随后 QQ 直接向 240e:...:60c5:56089 发 0x02 relay 探测包（1696 个），
   * 对端回包后 P2P 建立，媒体走 2493+1666 个包直连。
   * ```
   *
   * 另一形态（同一通 20 秒后的第二条 `bt=9`，也是 WeQ 实际收到的那条）：
   *
   * ```text
   * f1 bytes(10) 对端中继（嵌套的 RELAY_SERVER）
   * f4 bytes(10) 备选中继，可重复
   * f5 fixed32  对端 IPv4 地址            ★
   * f6 varint   对端 P2P 端口            ★
   * ```
   *
   * 旧实现只认 `f7`，于是「服务端给的是 IPv4 候选」这一路被整个丢掉 —— 只要对端
   * 是 IPv4 出口（或服务端选的是 IPv4 候选），就永远停在纯中继。
   *
   * **`f8` 只能当初始值。** 它是近似端口（实测 56082 vs 真实的 56089），权威值
   * 在 `bt=27`（见 {@link handlePeerJoin}）。但 `mediaTargets` 要求 `port > 0` 才发
   * 对端 —— 不发第一包，`bt=27` 也永远不会被触发，所以这里先用近似值打开局面。
   */
  private handlePeerAddress(body: Uint8Array): void {
    const fields = parsePb(body);
    const candidates: Array<{ address: string; port: number; ipv6: boolean }> = [];
    const relayCandidates: CallServer[] = [];

    const v6 = fields.find((f) => f.field === 7 && f.wire === 2)?.bytes;
    if (v6?.length === 16) {
      const address = formatIpv6(v6);
      if (address)
        candidates.push({ address, port: Number(pbGetVarint(body, 8) ?? 0), ipv6: true });
    }
    const v4 = fields.find((f) => f.field === 5 && f.wire === 5)?.fixed32;
    if (v4 !== undefined) {
      // f6 的端口在 IPv4 形态里是 protobuf fixed32，线上字节 `b9 22 00 00`
      // 按小端解出来是 0x000022b9 = 8889。parsePb 为了兼容地址字段按大端存成
      // 0xb9220000，所以这里要把高 16 位再按字节序还原，不能直接取高 16 位。
      const fixed = fields.find((f) => f.field === 6 && f.wire === 5)?.fixed32;
      const fixedPort = fixed === undefined ? 0 : fixed >>> 16;
      const wirePort = ((fixedPort & 0xff) << 8) | (fixedPort >>> 8);
      const port = Number(pbGetVarint(body, 6) ?? wirePort);
      candidates.push({ address: formatIpv4Fixed(v4), port, ipv6: false });
    }
    // `f3` 是本次通话的准入 token：它同时出现在中继 GET_IN 的 `[35:39]` 和每个
    // `0x02` 握手包里。信令那边解析失败时拿它兜底，否则中继永远不回我们。
    const pushToken = Number(pbGetVarint(body, 3) ?? 0);
    if (pushToken > 0 && pushToken !== this.authToken) {
      this.log?.info('bt=9 的准入 token 与信令不一致', {
        pushToken,
        signalingToken: this.authToken,
      });
      if (this.authToken === 0) this.authToken = pushToken;
    }
    for (const field of fields) {
      if ((field.field !== 1 && field.field !== 4) || field.wire !== 2 || !field.bytes) continue;
      const relay = parsePb(field.bytes);
      const ip = relay.find((item) => item.field === 1 && item.wire === 5)?.fixed32;
      const port = Number(relay.find((item) => item.field === 2 && item.wire === 0)?.value ?? 0);
      const type = Number(relay.find((item) => item.field === 3 && item.wire === 0)?.value ?? 0);
      if (ip === undefined || port <= 0) continue;
      relayCandidates.push({ ip: formatIpv4Fixed(ip), port, type });
    }
    if (relayCandidates.length > 0 && this.authToken > 0) {
      this.relays = relayCandidates;
      this.sendRelayGetIn();
      if (!this.relayTimer) this.startRelayKeepalive();
    }
    if (candidates.length === 0) return;

    // IPv6 优先（无 NAT，连通率最高）。
    const best = candidates[0]!;
    // 端口优先级：真实流量里学到的 > bt=27 的权威值（只对 IPv6 成立）> bt=9 的近似值。
    //
    // 为什么 bt=27 只套 IPv6：抓包里对端的 IPv6 socket 与 IPv4 socket 是两个端口
    // （56089 vs 18038），bt=27 下发的是它主端点（IPv6）的端口；IPv4 候选的端口
    // 就在 bt=9 的 f6 里，本来就是准的。
    const learned =
      this.lastPeerFrom && sameHost(this.lastPeerFrom.address, best.address)
        ? this.lastPeerFrom.port
        : 0;
    const announced = best.ipv6 ? this.peerAnnouncedPort : null;
    const port = learned > 0 ? learned : (announced ?? best.port);
    this.log?.info('拿到对端候选端点', { address: best.address, port, candidates });
    // 可信度分级：
    //   - 端口是从真实流量里学到的（learned）→ 对端确实从这儿发过包，可信；
    //   - IPv6 + bt=27 的权威端口 → 可信；
    //   - 其余（尤其 IPv4 的 f5/f6 近似值）→ 只是候选，必须等回程。
    //
    // 2026-10-26 实测：IPv4 候选 `11.149.189.80:8889` 发了 515 个媒体包，
    // **零回包**，旧实现却因为「拿到地址」就切了 direct，媒体从此离开 GCS。
    const trustworthy = learned > 0 || (best.ipv6 && announced !== null);
    this.applyPeerEndpoint(best.address, port, { provisional: !trustworthy });
  }

  /**
   * 处理 `bt=27`：服务端下发对端的真实 P2P 端口。
   *
   * 地址不在这条里，要和 `bt=9` 的 `f7` / `f5` 拼起来。端口到达后立即开始
   * `0x02` 打洞握手（真实客户端也是这个顺序）。
   */
  private handlePeerJoin(body: Uint8Array): void {
    const push = parsePeerJoin(body);
    if (!push) return;
    this.peerAnnouncedPort = push.port;
    this.log?.info('服务端下发对端 P2P 端口', { peerUin: push.peerUin, port: push.port });
    // 只有主端点（IPv6）用这个端口；IPv4 候选的端口在 bt=9 的 f6 里。
    const address = this.peerDirect?.address ?? this.lastPeerFrom?.address;
    if (!address) return;
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(address) || address.startsWith('::ffff:');
    if (!ipv4) this.applyPeerEndpoint(address, push.port);
  }

  /**
   * 确定对端端点并开始打洞。
   *
   * 这是「知道对端在哪」到「真的把路打通」之间的一步：探索包一发，对端就会回
   * `0x02` 应答，两端几乎同时切到直连（实测 QQ 从拿到地址到媒体直连 <200 ms）。
   *
   * **拿到地址 ≠ 直连可用。** 这里的两种来源可信度差很多：
   *
   * - `bt=27` 给的端口是服务端确认过的对端 P2P 端口，可以直接进 `probing`；
   * - 中继路径下发（`cmd=3`）、`bt=9` 的 IPv4 `f5/f6` 只是「候选」，
   *   2026-10-26 实测这些地址可能根本是黑洞（发出去 515 包、0 回包）。
   *
   * 所以 `provisional` 的候选**不改变 `mediaPath`**，只用来发打洞探测包；
   * 只有真收到回程（{@link confirmPeerPath}）或 `bt=27` 才允许进 `probing`。
   */
  private applyPeerEndpoint(
    address: string,
    port: number,
    opts: { provisional?: boolean } = {},
  ): void {
    // 禁用 P2P：不记对端端点，也就不会有打洞探测包与直连媒体。
    // 这一处必须挡在**最前面**，否则 `sendPeerProbe` 仍会按 `peerDirect` 打洞 ——
    // 实测会漏出一条 `0x02` 探测包（媒体包倒是拦住了）。
    if (this.opts.disableP2P) {
      this.log?.info('已禁用 P2P，忽略对端端点', { address, port });
      return;
    }
    const normalizedPort = port > 0 && port < 65536 ? port : 0;
    if (this.peerDirect?.address === address && this.peerDirect.port === normalizedPort) return;
    this.peerDirect = { address, port: normalizedPort };
    if (normalizedPort === 0) return;
    if (!opts.provisional && this.mediaPath === 'server') {
      this.mediaPath = 'probing';
      this.probeSince = this.timers.now();
      this.probeDeadlineAt = this.probeSince;
      this.peerProbeAnswered = false;
      this.log?.info('媒体路径切换', { path: 'probing' });
    }
    // 无论可信与否，都去打洞探测 —— 这是拿到回程证据的唯一途径。
    //
    // ⚠️ 循环已经在跑时也要**立刻补一拍**。`bt=27` 的权威端口常常晚于 `bt=9`
    // 到达，而 `bt=9` 已经启动了探测循环；只依赖 `startPeerProbeLoop()` 的话，
    // 新端口要等 2 秒后的下一拍才会用上，可探测期 1 秒就到期把端口清零了 ——
    // 权威端口于是永远发不出去，P2P 握手死锁在中继上。
    if (this.peerProbeTimer === null) this.startPeerProbeLoop();
    else this.sendPeerProbe();
  }

  /**
   * 公告本端 P2P 端点（`bt=25`）。
   *
   * 最多发 `max` 条：接通时一条，对端进房（收到 `bt=9`）后再补一条。
   *
   * ⚠️ **不要靠重发 `bt=25` 去催 `bt=27`。** 2026-10-26 Linux QQ 抓包实测：
   * `bt=27` 在 `bt=25` 之前 2.7ms 就到了（服务端主动推），两者是同一次协商的
   * 两个方向，不是「发了 25 才有 27」。拿不到 `bt=27` 是网络/服务端判定问题，
   * 重发只会制造噪音。
   */
  private sendPeerJoinReport(max = 1): void {
    if (!this.room || !['calling', 'ringing', 'connecting', 'connected'].includes(this.state)) {
      return;
    }
    if (this.peerJoinReports >= max) return;
    if (this.localPort <= 0) {
      if (this.peerJoinReports === 0) {
        this.log?.warn('拿不到本地 UDP 端口，跳过 P2P 端点公告');
        this.peerJoinReports = max;
      }
      return;
    }
    this.peerJoinReports++;
    this.send(
      buildPeerJoinReport({
        roomId: this.room.roomId,
        selfUin: Number(this.opts.selfUin),
        peerUin: Number(this.opts.peerUin),
        sessionTs: this.sessionTs,
        typeId: this.nextTypeId(),
        port: this.localPort,
      }),
    );
    this.log?.info('公告本端 P2P 端点', { port: this.localPort });
  }

  /** 下一个控制包序号（中继 GET_IN 与 P2P 握手共用）。 */
  private nextPeerSeq(): number {
    return ++this.peerPacketSeq;
  }

  /**
   * 启动 P2P 握手循环（`0x02` ch=1，2 秒一拍）。
   *
   * 第一拍是 `probe`；一旦对端回过应答就换成 `probeAck`（实测真机的稳态就是
   * 两秒一对 2/3）。
   */
  private startPeerProbeLoop(): void {
    if (this.peerProbeTimer !== null) return;
    const beat = () => this.sendPeerProbe();
    beat();
    this.peerProbeTimer = this.timers.setInterval(beat, PEER_PROBE_MS);
  }

  private stopPeerProbeLoop(): void {
    if (this.peerProbeTimer === null) return;
    this.timers.clearInterval(this.peerProbeTimer);
    this.peerProbeTimer = null;
  }

  private sendPeerProbe(): void {
    const peer = this.peerDirect;
    if (!this.room || !peer || peer.port <= 0) return;
    const packet = buildPeerProbe({
      roomId: this.room.roomId,
      cmd: this.peerProbeAnswered ? PeerProbeCmd.probeAck : PeerProbeCmd.probe,
      uinAbout: Number(this.opts.selfUin),
      seq: this.nextPeerSeq(),
      otherUin: Number(this.opts.peerUin),
      token: this.authToken,
      clock: this.tick(),
      peerClock: 0,
    });
    this.opts.transport.send(packet, peer.port, peer.address);
  }

  /**
   * P2P 握手包（`0x02` ch=1）。
   *
   * 只有「对方发来的探测」需要应答：0→1、2→3。收到 1/3 说明我们发出去的探测
   * 到了对方，这条路双向可用，媒体就可以停掉中继那份了。
   */
  private handlePeerChannel(data: Uint8Array, from: { address: string; port: number }): void {
    const probe = parsePeerProbe(data);
    if (!probe || !this.room) return;

    // 打洞包本身就是最可靠的端点来源：它就是从这个地址:端口发过来的。
    this.rememberPeerSource(from);
    if (probe.cmd === PeerProbeCmd.probe || probe.cmd === PeerProbeCmd.probeAck) {
      const reply: Uint8Array = buildPeerProbeReply(probe, {
        roomId: this.room.roomId,
        clock: this.tick(),
      });
      this.opts.transport.send(reply, from.port, from.address);
    }
    if (probe.cmd === PeerProbeCmd.probeReply || probe.cmd === PeerProbeCmd.probeAckReply) {
      this.peerProbeAnswered = true;
      this.confirmPeerPath();
    }
  }

  /**
   * 直连已双向确认：媒体立刻切到 P2P（不等探测期跑完）。
   *
   * 这是**唯一**能让 `mediaPath` 变成 `direct` 的路径之一（另一处是 `bt=27`
   * 给的权威端口 + 探测期）。没有这一步，任何「拿到地址就切」都会把媒体推进
   * 黑洞 —— 见 {@link mediaTargets} 的注释。
   */
  private confirmPeerPath(): void {
    this.lastPeerMediaAt = this.timers.now();
    this.peerProbeAnswered = true;
    this.probeDeadlineAt = 0;
    if (this.mediaPath === 'direct') return;
    if (!this.peerDirect || this.peerDirect.port <= 0) return;
    this.mediaPath = 'direct';
    this.log?.info('P2P 直连已确认，媒体切到直连', {
      address: this.peerDirect.address,
      port: this.peerDirect.port,
    });
  }

  /**
   * 记住对端包的来源地址与端口。
   *
   * P2P 的端口是**对端发起时临时协商**的，服务端下发的 bt=9 里没有 —— 但反过来，
   * 对端发给我们的包天然带着它的源地址:端口，直接拿来当回程目标即可。
   */
  private rememberPeerSource(from: { address: string; port: number }): void {
    // 判据是「来源 != 服务端」而不是「和 bt=9 一致」：bt=9 只给地址不给端口，
    // 而真正的回程端口只能从对端实际发包的来源学到。服务端地址要排除掉。
    //
    // ⚠️ **必须做地址归一化再比**。socket 是 udp6 双栈（`ipv6Only: false`），
    // IPv4 来源在 `rinfo.address` 里是 `::ffff:113.250.57.28` 形态，而服务器表里
    // 是 `113.250.57.28` —— 直接字符串比较永远不相等。后果很严重：服务器自己的
    // 回包被当成「对端直连地址」，媒体路径切到 direct，实际仍发往服务器（同 IP
    // 同端口），于是全程走中继、`bt=9` 也永远拿不到对端的 f7（IPv6），表现为
    // 两端画面都极卡。
    //
    // ⚠️ **中继节点也必须排除**。经中继转发的媒体包，源地址是中继自己，不是
    // 对端 —— 旧实现只排除了 GCS，于是中继的包既刷新了「直连还活着」的时间戳
    // （看门狗因此永远不回落），又把 `peerDirect` 改写成中继地址。2026-10-26
    // WeQ 抓包：整通 `sent 2478 / received 2389` 全在一条中继通道上，看门狗
    // 一次都没触发。
    const isServer =
      (this.gcs !== null && sameHost(this.gcs.ip, from.address) && this.gcs.port === from.port) ||
      this.relays.some((r) => sameHost(r.ip, from.address) && r.port === from.port);
    // 只有绕过服务端（和中继）的包才算「直连还活着」。
    if (!isServer) this.lastPeerMediaAt = this.timers.now();
    if (this.lastPeerFrom?.address === from.address && this.lastPeerFrom?.port === from.port)
      return;
    this.lastPeerFrom = from;
    if (isServer) return;
    this.peerDirect = { address: from.address, port: from.port };
    this.log?.info('学到对端直连地址', { address: from.address, port: from.port });
    // 首次学到端口：进入双发探测期。已经是 direct 时不动（回落由看门狗管）。
    // 这里的端口是**对端真的从这个地址发过包**得来的，可信，可以直接进 probing。
    if (this.mediaPath === 'server') {
      this.mediaPath = 'probing';
      this.probeSince = this.timers.now();
      this.probeDeadlineAt = this.probeSince;
      this.peerProbeAnswered = false;
      this.log?.info('媒体路径切换', { path: 'probing' });
    }
    // 对端已经在打我们了，我们也要跟上（否则对方收不到回程应答，不敢切直连）。
    this.startPeerProbeLoop();
  }

  private handleAuthRsp(): void {
    this.authAcked = true;
    this.clearGcsRetry();
    if (this.gcs) CallSession.goodGcsIp = this.gcs.ip;
    // relay token 通常在后续 bt=9 才下发；拿到 token 后再注册并开始保活。
    if (this.authToken > 0) {
      this.sendRelayGetIn();
      if (!this.relayTimer) this.startRelayKeepalive();
    }
    this.log?.debug('GCS 认证成功', { roomId: this.room?.roomId.toString() });
  }

  private ackPush(typeId: number, bodyType: number, body: Uint8Array): void {
    if (!this.room) return;
    this.send(
      buildGcsAck({
        roomId: this.room.roomId,
        selfUin: Number(this.opts.selfUin),
        sessionTs: this.sessionTs,
        typeId,
        pushBodyType: bodyType,
        pushBody: body,
        authKey: this.room.authKey,
      }),
    );
  }

  /**
   * 房间事件。
   *
   * 事件号的含义（`CallEvent`）：
   *   4 = 振铃 → `ringing`
   *   2/3 = 已进入 / 已接受 → `connecting`
   *   10 = 对端开始送音频 → `connected`（这条才是真正的「接通」）
   *   7 = 对端挂断 / 5 连接失败 / 8 超时 / 9 被踢 → 结束
   */
  private handleCallEvent(body: Uint8Array, typeId: number): void {
    this.ackPush(typeId, GcsBodyType.notifyPush, body);
    const event = parseCallEvent(body);
    if (!event) return;
    this.log?.debug('房间事件', { kind: event.event, peer: event.peerUin, seq: event.seq });

    switch (event.event) {
      case CallEvent.ringing:
        this.startVideoState();
        if (this.state === 'calling') {
          this.state = 'ringing';
          this.emit();
        }
        break;
      case CallEvent.entered:
      case CallEvent.accepted:
        if (this.state === 'calling' || this.state === 'ringing') {
          this.state = 'connecting';
          this.emit();
          this.armConnectTimeout();
        }
        break;
      case CallEvent.dataChange:
        this.markConnected();
        break;
      case CallEvent.logout:
        void this.teardown('peer_hangup');
        break;
      case CallEvent.connectFail:
        void this.teardown('connect_fail');
        break;
      case CallEvent.timeout:
        void this.teardown('timeout');
        break;
      case CallEvent.kickOut:
        void this.teardown('kicked');
        break;
      default:
        // invited / refusedAlt 等不影响状态。
        break;
    }
  }

  /**
   * 振铃后发起视频流状态协商。
   *
   * 2026-10-26 三通原生抓包（电脑→电脑 / 电脑→手机 / WeQ→手机）对照：
   * QQ 收到 `event=4` 后约 40–160 ms 发送 `bt=31 body=0803`（带 authKey）。
   * 服务端随后回普通 `bt=32 body=0803` 和 `bt=31 body=0806`。
   */
  private startVideoState(): void {
    if (this.videoStateStarted || !this.room) return;
    if (this.opts.media !== 'video' && !this.videoSending) return;
    this.videoStateStarted = true;
    this.sendVideoState(VideoStateCode.start);
  }

  /**
   * 处理 `bt=31` 视频流状态推送。
   *
   * 服务端下发 `f1=4` 时，原生客户端会同时发空 `bt=32` ACK 和
   * `bt=31 body=0805`。后者不是普通 ACK，不能由「未知奇数推送一律 ACK」代替；
   * 漏掉它时手机不会创建对端视频画面。
   */
  private handleVideoStatePush(packet: {
    body: Uint8Array;
    bodyType: number;
    typeId: number;
  }): void {
    this.ackPush(packet.typeId, packet.bodyType, packet.body);
    const state = pbGetVarint(packet.body, 1);
    this.log?.info('视频流状态推送', { state });
    if ((this.opts.media === 'video' || this.videoSending) && state === VideoStateCode.offer) {
      this.sendVideoState(VideoStateCode.accept);
    }
  }

  private sendVideoState(state: number): void {
    if (!this.room) return;
    this.send(
      buildVideoState({
        roomId: this.room.roomId,
        selfUin: Number(this.opts.selfUin),
        sessionTs: this.sessionTs,
        typeId: this.nextTypeId(),
        authKey: this.room.authKey,
        state,
      }),
    );
    this.log?.info('发送视频流状态', { state });
  }

  private markConnected(): void {
    // 异步挂断期间的迟到 dataChange 不能复活通话。
    if (this.state === 'connected' || this.state === 'ending') return;
    if (this.state === 'ended' || this.state === 'failed') return;
    this.clearTimer('connectTimer');
    this.state = 'connected';
    this.connectedAt = this.timers.now();
    // 样本计数器与 ssrc 基线在同一时刻定下来，二者必须同源。
    this.sampleBase = (this.tick() * 16) >>> 0;
    // sub-header [12:16] 的会话基准 tick，整通不变。
    this.mediaBaseTick = this.tick();
    this.startQfb();
    this.startAudioLoop();
    this.startVideoWatchdog();
    this.startMediaWatchdog();
    // 把自己的 P2P 端口公告出去 —— 不发这条，对端永远不知道往哪打洞。
    this.sendPeerJoinReport();
    // QQ 的默认行为：**视频通话接通时双方摄像头自动打开**（对方可以选择
    // 语音接听，但那不影响我们这边开摄像头）。语音通话则保持关闭。
    //
    // 这里在 emit 之前切，界面上接通的那一刻就已经是「本端在发视频」。
    if (this.opts.media === 'video' && !this.videoSending) {
      this.videoSending = true;
      this.sendVideoControl();
      this.videoFrameIndex = 0;
      this.startVideoLoop();
      this.startVideoKeepalive();
      this.log?.info('视频通话接通，自动开启摄像头');
    }
    this.emit();
  }

  /**
   * `0x5b` 的分流。
   *
   * 音频、视频、质量反馈、控制包共用这一个首字节，靠 `[3]` 的 subType 区分：
   *
   *   0x01 音频 / 0x02 大画面 / 0x03 小画面 / 0x07 屏幕共享
   *   0x04 摄像头开关控制 / 0x05 视频保活 / 0x0e 质量反馈
   *
   * ⚠️ 早先这里对非音频一律 `return`，视频包会被**静默丢弃**——表现为「对方
   * 明明开了摄像头但什么都收不到」。
   */
  private handleAudio(data: Uint8Array): void {
    const header = parseAudioHeader(data);
    if (!header) return;
    this.lastPeerTick = header.tick;
    // 每个子类型**首次**出现时记一笔就够了：排查「对端到底发没发」时这是唯一
    // 线索，但逐包记录会刷屏（一通视频通话上千条，实测 1014 条/通）。
    if (header.subType !== AudioSubType.audio && !this.seenMediaSubTypes.has(header.subType)) {
      this.seenMediaSubTypes.add(header.subType);
      this.log?.info('收到媒体包子类型', {
        subType: `0x${header.subType.toString(16)}`,
        len: data.length,
        from: 'peer',
      });
    }

    switch (header.subType) {
      case AudioSubType.qfb:
        this.handleQfb(data, header.tick);
        return;
      case VIDEO_CTRL_SUB_TYPE:
        this.handleVideoControl();
        return;
      case VIDEO_KEEPALIVE_SUB_TYPE:
        // 保活只说明「对端视频会话还在」，不改变状态。
        return;
      case AudioSubType.audio:
        this.handleAudioFrame(data);
        return;
      default:
        if (isVideoSubType(header.subType)) {
          this.handleVideoPacket(data);
          return;
        }
        return;
    }
  }

  private handleQfb(data: Uint8Array, tick: number): void {
    const qfb = parseQfb(data.subarray(17));
    if (qfb && qfb.type === 1) {
      this.send(
        buildQfbResponse({
          seq: this.qfbSeq,
          sessionTs: this.sessionTs,
          tick: this.tick(),
          qfbSeq: qfb.qfbSeq,
          echoTs: tick,
        }),
      );
    }
  }

  private handleAudioFrame(data: Uint8Array): void {
    const frame = parseAudioFrame(data);
    if (!frame?.isOpus || frame.payload.length === 0) return;

    // 组内前 3 帧带的是上一组的校验行，这里不做恢复（服务端已保证 Jitter
    // Buffer 足够长），只负责把 FEC 容器从载荷里切掉。
    if (frame.version === 0x50) {
      parseFecContainer(data.subarray(17));
    }

    this.receivedFrames++;
    void this.deliverAudio(frame);
  }

  private async deliverAudio(frame: AudioFrame): Promise<void> {
    try {
      const pcm = await this.opts.codec.decode(frame.payload);
      for (const listener of this.audioListeners) listener(pcm, this.timers.now());
    } catch (error) {
      this.log?.warn('解码一帧失败', { error });
    }
  }

  // ── 视频 ──

  /**
   * 收到对端的摄像头控制包（`subType=4`，空体）。
   *
   * **不是「开启一次」的信号，而是周期性的状态公告。** 2026-10-25 真机抓包里，
   * 一方在 14 秒内发了 **316 个**（每秒 20+），成对出现，`tick` 每对递增。
   * 也就是说它更像「我还在发视频」的心跳，而不是「开 / 关」的边沿。
   *
   * 早先实现按「收到即取反」处理 —— 在真机这种高频流下会每秒翻转 20 次，
   * 界面表现为在「等待画面」和「画面」之间频闪，Linux 侧则一直转圈。
   *
   * 现在改成**幂等**：收到就置为「在接收」，关闭交给两条兜底 ——
   * {@link startVideoWatchdog}（视频静默超时）和会话挂断。
   */
  private handleVideoControl(): void {
    this.lastVideoControlAt = this.timers.now();
    if (this.videoReceiving) return;
    this.videoReceiving = true;
    this.log?.info('对端控制包：对端在发视频');
    this.emit();
  }

  private handleVideoPacket(data: Uint8Array): void {
    const packet = parseVideoPacket(data);
    if (!packet) return;

    const frame = this.videoAssembler.push(packet, this.timers.now());
    if (!frame) return;

    // 控制包是权威信号（对端开 / 关），视频包只做兜底：万一控制包丢了，
    // 收到真画面也该把状态点亮。
    if (!this.videoReceiving) {
      this.videoReceiving = true;
      this.log?.info('开始接收对端视频（由视频包触发）', { subType: packet.subType });
      this.emit();
    }
    this.receivedVideoFrames++;
    this.lastVideoPacketAt = this.timers.now();

    // 记下对端视频流的时间基准：本端 sub-header 的 `[12:16]` 要填它。
    // 实测是「对端首个视频帧的 `[8:12]` 值」，收到后整通不变。
    if (this.peerVideoBase === 0 && frame.timestamp !== 0) {
      this.peerVideoBase = frame.timestamp;
      this.log?.info('记下对端视频时间基准', { peerVideoBase: frame.timestamp });
    }

    const hevc = extractHevc(frame);
    // 前几帧把组帧结果打出来：拼不上 / 剥不出裸流是「收到包但没画面」的典型原因。
    if (this.receivedVideoFrames <= 5 || this.receivedVideoFrames % 50 === 0) {
      this.log?.info('视频帧组装', {
        gidx: frame.gidx,
        fidx: frame.fidx,
        keyframe: frame.isKeyframe,
        subHeaderSize: frame.subHeaderSize,
        frameBytes: frame.frameData.length,
        hevc: hevc ? hevc.length : null,
        pending: this.videoAssembler.pendingCount,
      });
    }
    // 只在关键帧上读规格，避免每帧都解析 SPS。
    if (hevc && frame.isKeyframe) {
      const info = readHevcInfo(hevc);
      if (info && !this.videoInfo) {
        this.videoInfo = info;
        this.log?.info('对端视频规格', { ...info });
        this.emit();
      }
    }

    const payload: VideoFramePayload = {
      gidx: frame.gidx,
      fidx: frame.fidx,
      frameIndex: frame.frameIndex,
      isKeyframe: frame.isKeyframe,
      timestamp: frame.timestamp,
      info: this.videoInfo,
      hevc,
    };
    const at = this.timers.now();
    for (const listener of this.videoListeners) listener(payload, at);
  }

  /** 发摄像头开关控制包（连发两次防丢包，与真实客户端一致）。 */
  private sendVideoControl(): void {
    const packet = buildVideoControl({
      sessionTs: this.sessionTs,
      tick: this.tick(),
    });
    this.log?.info('发摄像头控制包', {
      to: this.gcs ? `${this.gcs.ip}:${this.gcs.port}` : 'none',
      peer: this.peerDirect ? `${this.peerDirect.address}:${this.peerDirect.port}` : 'none',
      sessionTs: this.sessionTs,
      hex: Array.from(packet, (b) => b.toString(16).padStart(2, '0')).join(''),
    });
    // 连发两次防丢包。去向跟随当前媒体路径：中继阶段只到服务端（真实客户端也是
    // 这样 —— 7.9 秒切换前它的控制包同样只发服务端）。
    this.sendMedia(packet);
    this.sendMedia(packet);
  }

  /**
   * 媒体路径看门狗。
   *
   * 直连模式下如果对端不再回包（地址学错、P2P 被网络掐断……），继续只发直连
   * 就会彻底失联。这里每秒查一次：超过 {@link MEDIA_DIRECT_TIMEOUT_MS} 没收到
   * 任何 `0x5b` 包就退回服务端中继，并把端口清零等下一次重新学习。
   */
  private startMediaWatchdog(): void {
    if (this.mediaWatchdogTimer !== null) return;
    this.mediaWatchdogTimer = this.timers.setInterval(() => {
      if (this.mediaPath !== 'direct') return;
      if (this.lastPeerMediaAt === 0) return;
      const silent = this.timers.now() - this.lastPeerMediaAt;
      if (silent < MEDIA_DIRECT_TIMEOUT_MS) return;
      this.log?.warn('对端直连静默超时，回落服务端中继', { silentMs: silent });
      this.mediaPath = 'server';
      // 地址留着（bt=9 给的是对的），端口归零，等对端下次发包重新学。
      if (this.peerDirect) this.peerDirect = { address: this.peerDirect.address, port: 0 };
      this.lastPeerFrom = null;
      this.peerProbeAnswered = false;
      this.probeDeadlineAt = 0;
    }, 1000);
  }

  /**
   * 视频接收看门狗。
   *
   * 对端关摄像头时除了发控制包，还会停发视频流。控制包是 UDP，可能丢 ——
   * 丢了我们就会一直卡在「等待对方画面」。这里每秒查一次：超过
   * {@link VIDEO_SILENCE_MS} 没收到视频包就认定对端已停。
   *
   * 只在「正在接收」时才检查，避免刚开摄像头那几百毫秒的建流期被误判。
   */
  private startVideoWatchdog(): void {
    if (this.videoWatchdogTimer !== null) return;
    this.videoWatchdogTimer = this.timers.setInterval(() => {
      if (!this.videoReceiving) return;
      // 取「视频包」和「控制包」里更近的那个：控制包是周期公告，停了同样说明
      // 对端不再发视频。两者都没有过就还没开始，不判定。
      const last = Math.max(this.lastVideoPacketAt, this.lastVideoControlAt);
      if (last === 0) return;
      const silent = this.timers.now() - last;
      if (silent < VIDEO_SILENCE_MS) return;
      this.log?.info('对端视频静默超时，按已关闭处理', { silentMs: silent });
      this.videoReceiving = false;
      this.lastVideoControlAt = 0;
      this.videoAssembler.reset();
      this.emit();
    }, 1000);
  }

  /**
   * 视频保活：每 2 秒**两条**，视频停了也继续发到挂断。
   *
   * 实测真实客户端的两条间隔 40–90 ms，body 首字节分别是 `0x02` 和 `0x03`：
   * 前者报自己的 tick，后者附带「我收到你发到哪个 tick」的回执。只发前一种时
   * 对端没有直连通断的判据。
   */
  private startVideoKeepalive(): void {
    if (this.videoKeepaliveTimer !== null) return;
    const beat = () => {
      this.sendMedia(
        buildVideoKeepalive({
          sessionTs: this.sessionTs,
          tick: this.tick(),
          variant: 0x02,
        }),
      );
      // 第二条错开一点，别和第一条挤在同一毫秒。
      this.timers.setTimeout(() => {
        this.sendMedia(
          buildVideoKeepalive({
            sessionTs: this.sessionTs,
            tick: this.tick(),
            variant: 0x03,
            peerTick: this.lastPeerTick,
          }),
        );
      }, VIDEO_KEEPALIVE_SECOND_MS);
    };
    beat();
    this.videoKeepaliveTimer = this.timers.setInterval(beat, VIDEO_KEEPALIVE_MS);
  }

  private stopVideoKeepalive(): void {
    if (this.videoKeepaliveTimer === null) return;
    this.timers.clearInterval(this.videoKeepaliveTimer);
    this.videoKeepaliveTimer = null;
  }

  /**
   * 视频发送循环。
   *
   * 与音频的固定 20 ms 节拍不同，视频帧率由编码器决定（实测 10 fps，且帧间隔
   * 抖动很大）——所以这里是「编码器有帧就发，没有就等下一拍」。用 10 ms 的
   * 轮询兜住：比最慢的帧间隔小一个量级，又不会把主进程拖满。
   */
  private startVideoLoop(): void {
    if (this.videoTimer !== null) return;
    const pump = () => {
      this.videoTimer = this.timers.setTimeout(() => {
        void this.pumpVideo();
      }, VIDEO_PUMP_MS);
    };
    pump();
  }

  private stopVideoLoop(): void {
    if (this.videoTimer === null) return;
    this.timers.clearTimeout(this.videoTimer);
    this.videoTimer = null;
  }

  private async pumpVideo(): Promise<void> {
    if (!this.videoSending || this.state !== 'connected') return;
    const encoder = this.videoEncoder;
    if (!encoder) {
      // 没有编码器：控制包已经发了，对端会显示「等待对方画面」。
      // 这里**不能**继续轮询 —— 每 10ms 空转一次纯烧 CPU，而且永远不会有帧。
      this.stopVideoLoop();
      this.log?.info('本端没有视频编码器，只发控制信令不发画面');
      return;
    }

    try {
      const hevc = await encoder.next();
      if (hevc && hevc.length > 0) {
        this.sentVideoFrames++;
        if (this.sentVideoFrames <= 3 || this.sentVideoFrames % 30 === 0) {
          this.log?.info('发出视频帧', {
            n: this.sentVideoFrames,
            bytes: hevc.length,
            queued: this.videoEncoder?.pendingFrameCount ?? -1,
          });
        }
        this.sendVideoFrame(hevc);
      } else if (this.sentVideoFrames === 0) {
        // 一直取不到帧：多半是渲染层没推 I420 进来。
        this.videoStarvedTicks++;
        if (this.videoStarvedTicks === 30) {
          this.log?.warn('视频发送一直取不到帧（渲染层可能没推 I420）');
        }
      }
    } catch (error) {
      this.log?.warn('编码一帧视频失败', { error });
    }

    if (!this.videoSending) return;
    this.videoTimer = this.timers.setTimeout(() => {
      void this.pumpVideo();
    }, VIDEO_PUMP_MS);
  }

  /**
   * 把一帧 Annex B 裸流切包发出去。
   *
   * 20 字节 sub-header + 裸流等分切包，每片一个 `0x5b subType=2` 包。单个 UDP
   * 载荷约 1200 字节（IPv6 路径下更大，但 1200 是安全值）。
   *
   * 三个字段按实测填（见 {@link buildVideoSubHeader}）：
   * - `[2]=0x00`（c2s 方向，不是 0x03）；
   * - `[8:12]` 帧 PTS = 距接通时刻的毫秒数（不是 `Date.now()`）；
   * - `[12:16]` 接通时定下的会话基准 tick。
   */
  private sendVideoFrame(hevc: Uint8Array): void {
    const now = this.timers.now();
    const ptsMs = this.connectedAt === null ? 0 : now - this.connectedAt;
    // `[16:20]` 要提前知道片数，所以先按「sub-header + 裸流」的总长估一次。
    // 实测取值是 `0..totalPkg-1` 里的一个值（不是 `totalPkg-1` 定值），语义未
    // 还原，用随机值对齐分布。
    const packetCount = videoPacketCount(VIDEO_SUBHEADER_LEN + hevc.length);
    this.videoFrameFragment = packetCount <= 1 ? 0 : Math.floor(Math.random() * packetCount);
    const subHeader = buildVideoSubHeader({
      direction: 'c2s',
      frameIndex: this.videoFrameIndex,
      timestampMs: ptsMs,
      peerVideoBase: this.peerVideoBase,
      // `[6:8]`：对端只拿它做统计，按真实分布抽样即可（见 sampleVideoFrameQuality）。
      quality: sampleVideoFrameQuality(splitHevcNals(hevc).some((nal) => isIrapNalType(nal.type))),
      fragment: this.videoFrameFragment,
    });
    const frameData = new Uint8Array(subHeader.length + hevc.length);
    frameData.set(subHeader, 0);
    frameData.set(hevc, subHeader.length);

    const packets = buildVideoPackets({
      frameData,
      // 16 位帧序号：包头里的 gidx/fidx 由它拆出。只写 gidx 会在第 256 帧回绕、
      // 帧序号倒退，对端按序号判连续性时会当成乱序而丢帧。
      frameIndex: this.videoFrameIndex,
      sessionTs: this.sessionTs,
      // tick 帧内恒定；seq 由 buildVideoPackets 按片递增。
      tick: this.tick(),
      seq: this.videoSeq,
    });
    this.videoSeq += packets.length;
    for (const packet of packets) this.sendMedia(packet);
    this.videoFrameIndex++;
  }

  /**
   * `0x02` 分流。
   *
   * - `[4] = 1`：P2P 打洞握手（cmd 0–3），走 {@link handlePeerChannel}；
   * - `[4] = 0`：服务端通道 —— GET_IN 应答（cmd=2）/ 对端路径下发（cmd=3）。
   *
   * 旧实现只看 `[5:7]` 的 cmd 且只打日志，P2P 通道的包全被当成服务端包丢掉了：
   * 对端的打洞探测没人应答，对方就一直不敢切直连。
   */
  private handleRelay(data: Uint8Array, from: { address: string; port: number }): void {
    if (data.length < 7) return;
    if (data[4] === RELAY_CHANNEL.peer) {
      this.handlePeerChannel(data, from);
      return;
    }
    const cmd = (data[5]! << 8) | data[6]!;
    // GET_IN 的应答（cmd=2）说明中继通道注册成功。
    if (cmd === RelayCmd.getInAck) {
      this.log?.debug('中继通道已注册');
    } else if (cmd === RelayCmd.peerPathInfo) {
      const body = data.subarray(RELAY_HEADER_LEN);
      if (body.length >= 24) {
        const address = `${body[0]}.${body[1]}.${body[2]}.${body[3]}`;
        const primaryPort = (body[6]! << 8) | body[7]!;
        const directPort = (body[22]! << 8) | body[23]!;
        const port = directPort > 0 ? directPort : primaryPort;
        // 回 ACK（cmd=4）。真实客户端收到路径下发就应答，不回的话中继会每秒重发
        // 同一条（2026-10-26 WeQ 抓包：cmd=3 从 64 秒一直刷到挂断，cmd=4 一条
        // 都没有）。应答走「来的那个中继节点」原路返回。
        this.sendRelayPeerPathAck(from);
        // ⚠️ **这条下发的是「对端在哪条中继通道上」，不是对端直连地址。**
        // 旧实现直接 `applyPeerEndpoint(address, port)`，把中继节点自己当成了
        // 对端：媒体从 GCS 挪到中继、`mediaPath` 变成 `direct`，于是「以为直连
        // 了，其实还在中继」—— 和文档 §7.1.2 第 2 个坑同构，只是这次来源是
        // 中继推送而不是服务器回包。
        //
        // 判据：地址若是中继节点自己（或就是 GCS），一律只记日志。
        this.log?.info('中继下发对端路径', {
          address,
          primaryPort,
          directPort,
          from: from.address,
        });
        const isRelaySelf =
          (this.gcs !== null && sameHost(this.gcs.ip, address) && this.gcs.port === port) ||
          this.relays.some((r) => sameHost(r.ip, address) && r.port === port) ||
          this.relays.some((r) => sameHost(r.ip, address) && r.port === primaryPort) ||
          sameHost(from.address, address);
        if (isRelaySelf) {
          this.log?.info('中继路径是节点自身，不当作对端端点', { address, port });
          return;
        }
        // 即便不是节点自身，中继下发的也只是「中继侧入口」，仍然要等回程证据
        // 才允许切直连 —— 所以这里只把它作为候选交给探测，不改变 mediaPath。
        if (port > 0) this.applyPeerEndpoint(address, port, { provisional: true });
      }
    }
  }

  /**
   * 回 `cmd=4`：确认收到中继的对端路径下发。
   *
   * body 全 0（16 字节），和 `cmd=3` 的 24 字节 body 不同 —— 见 2026-10-26
   * QQ 本体抓包：`cmd=3` 84 字节、`cmd=4` 56 字节，差值正好是 body 长度。
   */
  private sendRelayPeerPathAck(to: { address: string; port: number }): void {
    if (!this.room) return;
    this.opts.transport.send(
      buildRelayPacket({
        roomId: this.room.roomId,
        selfUin: Number(this.opts.selfUin),
        peerUin: Number(this.opts.peerUin),
        seq: this.relaySeq,
        token: this.authToken,
        channel: RELAY_CHANNEL.server,
        cmd: RelayCmd.peerPathAck,
        body: new Uint8Array(16),
      }),
      to.port,
      to.address,
    );
  }

  // ── 超时 ──

  private armRingTimeout(): void {
    this.clearTimer('ringTimer');
    this.ringTimer = this.timers.setTimeout(() => {
      if (this.state === 'calling' || this.state === 'ringing') {
        void this.teardown('timeout');
      }
    }, RING_TIMEOUT_MS);
  }

  private armConnectTimeout(): void {
    this.clearTimer('connectTimer');
    this.connectTimer = this.timers.setTimeout(() => {
      if (this.state === 'connecting') void this.teardown('timeout');
    }, CONNECT_TIMEOUT_MS);
  }

  private clearTimer(name: 'ringTimer' | 'connectTimer'): void {
    const handle = this[name];
    if (handle !== null) {
      this.timers.clearTimeout(handle);
      this[name] = null;
    }
  }

  // ── 收尾 ──

  private fail(message: string): void {
    this.lastError = message;
    this.log?.error('通话失败', { error: message });
    void this.teardown('error');
  }

  /**
   * 拆掉会话。
   *
   * 顺序有讲究：**先**给 GCS 发 UDP 登出（重发 5 次），**再**发 MSF 登出。
   * 反过来中继不会拆连接，对端会一直停在「通话中」。
   */
  private teardownPromise: Promise<void> | null = null;

  private teardown(reason: CallEndReason): Promise<void> {
    if (this.teardownPromise) return this.teardownPromise;
    if (this.state === 'ended' || this.state === 'failed') return Promise.resolve();
    // 对端挂断也要立刻进入 ending，避免信令 await 期间被接通包重新激活。
    this.state = 'ending';
    this.endReason = reason;
    this.teardownPromise = this.finishTeardown(reason);
    return this.teardownPromise;
  }

  private async finishTeardown(reason: CallEndReason): Promise<void> {
    this.stopTimers();

    // 只要房间建出来了就必须收尾 —— 包括**失败路径**：开房 + 邀请是两条独立的
    // 信令，后者成功时对端已经在振铃了。此时若因为后面某一步（编解码器、UDP
    // 绑定…）失败就直接返回，对端会一直响到服务端超时。失败时更该主动挂断。
    if (this.room) {
      const logout = buildGcsLogout({
        roomId: this.room.roomId,
        selfUin: Number(this.opts.selfUin),
        sessionTs: this.sessionTs,
        typeId: this.nextTypeId(),
        authKey: this.room.authKey,
      });
      for (let i = 0; i < LOGOUT_REPEATS; i++) this.send(logout);

      try {
        await this.opts.signaling.end({
          selfUid: this.opts.selfUid,
          roomId: this.room.roomId,
          relationId: this.relationId,
        });
      } catch (error) {
        this.log?.warn('挂断信令失败', { error });
      }
    }

    // 先把状态落到终态，再释放资源。
    //
    // 顺序反过来过一次：`codec.close()` 卸载 native 模块时，Windows 上曾直接
    // fail-fast 掉整个主进程（AVSDKPlugin 的后台线程还在跑，模块一卸就踩空）。
    // 进程都没了，后面那行「通话结束」自然也没人写 —— 界面上就是点了挂断毫无
    // 反应。native 侧已经改成模块永不卸载，但这里同样要把**本模块能控制的部分**
    // 排在前面：终态与日志先落，清理即使出岔子也不会让 UI 卡在「正在挂断」。
    const wasConnected = this.connectedAt !== null;
    this.state = reason === 'error' ? 'failed' : 'ended';
    if (reason === 'error' && !this.lastError) this.lastError = '未知错误';
    this.log?.info('通话结束', {
      reason,
      connected: wasConnected,
      sent: this.sentFrames,
      received: this.receivedFrames,
    });
    this.emit();

    // 释放顺序：先关 UDP 再关编解码器 —— 反过来的话，还在收包路径上的
    // 回调会拿着已关闭的解码器去解一帧。
    try {
      this.opts.transport.close();
    } catch (error) {
      this.log?.warn('关闭 UDP 失败', { error });
    }
    try {
      this.opts.codec.close();
    } catch (error) {
      this.log?.warn('关闭编解码器失败', { error });
    }
    try {
      this.videoEncoder?.close();
    } catch (error) {
      this.log?.warn('关闭视频编码器失败', { error });
    }
    this.videoEncoder = null;
    this.videoAssembler.reset();
    this.videoSending = false;
    this.videoReceiving = false;
    this.videoSource = 'camera';
    this.sendQueue.length = 0;
  }

  private stopTimers(): void {
    const pairs: Array<[unknown, 'clearInterval' | 'clearTimeout']> = [
      [this.heartbeatTimer, 'clearInterval'],
      [this.statusTimer, 'clearInterval'],
      [this.qfbTimer, 'clearInterval'],
      [this.relayTimer, 'clearInterval'],
      [this.audioTimer, 'clearTimeout'],
      [this.ringTimer, 'clearTimeout'],
      [this.connectTimer, 'clearTimeout'],
      [this.gcsRetryTimer, 'clearTimeout'],
      [this.videoKeepaliveTimer, 'clearInterval'],
      [this.videoTimer, 'clearTimeout'],
      [this.videoWatchdogTimer, 'clearInterval'],
      [this.mediaWatchdogTimer, 'clearInterval'],
    ];
    for (const [handle, kind] of pairs) {
      if (handle !== null) this.timers[kind](handle);
    }
    this.stopPeerProbeLoop();
    this.heartbeatTimer = null;
    this.statusTimer = null;
    this.qfbTimer = null;
    this.relayTimer = null;
    this.audioTimer = null;
    this.ringTimer = null;
    this.connectTimer = null;
    this.gcsRetryTimer = null;
    this.videoKeepaliveTimer = null;
    this.videoTimer = null;
    this.videoWatchdogTimer = null;
    this.mediaWatchdogTimer = null;
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

// ─────────────────────────── 组装 ───────────────────────────

/** 用 `@weq/protocol` 的信令实现 + 已登记的 pid 造一个信令客户端。 */
export function protocolSignaling(
  nt: Parameters<typeof startC2CCall>[0],
  pid: number,
): CallSignaling {
  return {
    start: (params) => startC2CCall(nt, pid, params),
    end: (params) => endC2CCall(nt, pid, params),
  };
}

/** 只读的会话参数（给界面显示用）。 */
export interface CallTarget {
  uin: string;
  uid: string;
  displayName?: string;
  avatarUrl?: string;
}
