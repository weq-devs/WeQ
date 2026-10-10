/**
 * 提权抓包的线上协议（主进程 ↔ 提权 capture worker），以及帧的「wire」形态。
 *
 * 为什么要提权：Linux/macOS 上抓包要打开原始套接字（AF_PACKET / BPF），内核要求
 * euid=0 或 CAP_NET_RAW。而 Electron **不能以 root 运行**，所以只能把「抓包会话」
 * 这一段放进一个短命的 root 子进程（见 `capture_worker.ts`），主进程按本协议代理
 * 前端来的 `captureStart` / `capturePoll` / `captureStop`。
 *
 * 为什么协议走环回套接字而不是 stdin/stdout：`sudo -S` 要从 **stdin** 读密码，
 * 跟协议复用同一条管道会有缓冲边界问题（sudo 可能多读几个字节）。所以 worker 起来
 * 后在 `127.0.0.1` 上监听随机端口，把 `{port, token}` 作为**唯一一行 hello** 打到
 * stdout；主进程连上去，首帧必须带 token。sudo 只碰 stdin，协议只碰套接字。
 *
 * 帧一律走 hex（与 tRPC 那条线同一套形态），省掉在协议边界上纠结 Buffer 序列化。
 */

import type { CapturedFrame, CaptureSession, CaptureStats } from '@weq/native';

/** 一帧的可序列化形态（hex）。前端 / tRPC / worker 协议共用同一份定义。 */
export interface CaptureFrameWire {
  cursor: number;
  ts: number;
  direction: 'c2s' | 's2c';
  proto: number;
  encryptType: number;
  seq: number;
  cmd: string | null;
  rawHex: string;
  plainHex: string;
  bodyHex: string;
}

/** 一次已 armed 的抓包会话（native 返回什么就透传什么）。 */
export type CaptureSessionWire = CaptureSession;

/** `takeFrames` 的一批结果（hex 化）。 */
export interface CaptureBatchWire {
  frames: CaptureFrameWire[];
  nextCursor: number;
  dropped: number;
}

/** `stopCapture` 的统计。 */
export type CaptureStatsWire = CaptureStats;

/** worker 起好监听后打在 stdout 上的唯一一行 hello。 */
export interface CaptureWorkerHello {
  /** 环回监听端口。 */
  port: number;
  /** 首帧必须携带的随机口令（只有读到我们 stdout 的人知道）。 */
  token: string;
  /** 子进程的 euid —— 0 说明 sudo 生效了；不是 0 应当直接报错。 */
  euid: number;
  /** 抓包后端名（`libpcap (static)` 之类），仅用于日志。 */
  backend: string;
}

/**
 * 请求。**首帧必须带 token**，后续省略。
 *
 * 刻意做成扁平结构（而不是按 op 判别的联合）：`Omit<…, 'id' | 'token'>` 在调用侧
 * 拼包时不会被联合搞得四处报错，而这里本来就是一个跨进程的线上格式、字段都靠 op 解释。
 */
export interface CaptureWorkerRequest {
  /** 请求序号，应答原样回带。 */
  id: number;
  /** 只有首帧需要带（口令门禁）。 */
  token?: string;
  op: 'start' | 'take' | 'stop';
  pid: number;
  /** `start` 用：网卡（默认 auto）。 */
  iface?: string;
  /** `start` 用：MSF 端口策略（默认 auto）。 */
  port?: string;
  /**
   * `start` 用：显式 d2key（32 字符 hex）。子进程是**另一个 native 实例**，主进程
   * 里 `setSsoSession` 注册的会话物料在它那边不存在，所以必须显式给。
   *
   * 注意：这是**线上协议**的字段名（内部命名）。子进程调 native 的
   * `startCapture` 时要映射成 **`d2Key`** —— napi 把 Rust 的 `d2key` 转成了
   * `d2Key`，写成 `d2key` 会被静默忽略。
   */
  d2key?: string;
  /** `take` 用：续取游标。 */
  cursor?: number;
  /** `take` 用：最多等多久（毫秒）再返回。 */
  waitMs?: number;
}

/** 应答。`result` 的具体类型由 `op` 决定（start→CaptureSessionWire …）。 */
export type CaptureWorkerReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** 把 native 的 `CapturedFrame` 转成可走 tRPC / 套接字的 hex 形态。 */
export function toCaptureFrameWire(f: CapturedFrame): CaptureFrameWire {
  return {
    cursor: f.cursor,
    ts: f.ts,
    direction: f.direction === 'c2s' ? 'c2s' : 's2c',
    proto: f.proto,
    encryptType: f.encryptType,
    seq: f.seq,
    cmd: f.cmd ?? null,
    rawHex: f.raw ? Buffer.from(f.raw).toString('hex') : '',
    plainHex: f.plain ? Buffer.from(f.plain).toString('hex') : '',
    bodyHex: f.body ? Buffer.from(f.body).toString('hex') : '',
  };
}
