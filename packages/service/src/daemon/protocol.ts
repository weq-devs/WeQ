/**
 * weq-daemon 控制管道协议 —— Rust 侧 `packages/daemon/src/protocol.rs` 的 TS 镜像。
 *
 * 分帧：4 字节小端长度 + JSON（UTF-8）。单帧上限 1 MiB。
 * 请求 / 响应都是单帧；服务端每连接只处理一个请求后关闭。
 * `stop` 命令服务端不回帧（直接断开，客户端读 EOF 即成功）。
 *
 * 这是「统一管道服务」的协议层：以后给守护进程加新能力（例如监听 GitHub
 * release 更新）= Rust 侧加一个 `Request` 变体 + 这里加对应类型 + client 的
 * 一个薄封装方法。管道、分帧、探活、启动逻辑全部复用。
 */

import { tmpdir } from 'node:os';

/** 默认管道名（与 Rust `DEFAULT_PIPE_NAME` 一致；状态文件也按它区分）。 */
export const DAEMON_PIPE_NAME = 'weq-daemon';

/** 单帧 JSON 上限（与 Rust `MAX_FRAME` 一致）。 */
export const DAEMON_MAX_FRAME = 1024 * 1024;

/** 当前协议版本标记（写进 ping 响应，便于排查两端不匹配）。 */
export type DaemonRequest =
  | { cmd: 'ping' }
  | { cmd: 'http_start'; port: number; docroot: string }
  | { cmd: 'http_stop' }
  | { cmd: 'http_status' }
  | { cmd: 'stop' };

export type DaemonResponse =
  | { res: 'pong'; version: string; http_running: boolean }
  | { res: 'started'; port: number }
  | { res: 'stopped' }
  | { res: 'http_status'; running: boolean; port: number | null; docroot: string | null }
  | { res: 'error'; message: string };

/** 控制管道的完整连接目标。 */
export function daemonPipePath(pipeName = DAEMON_PIPE_NAME): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}` // Windows named pipe
    : `${tmpdir()}/${pipeName}.sock`; // unix domain socket（与 Rust socket_path 一致）
}

/**
 * 把一帧响应 JSON 解析成 {@link DaemonResponse}；形状不符回 error 帧。
 * 网络对端是本机守护进程，但输入仍按不可信处理（坏帧不抛，可日志可上报）。
 */
export function parseDaemonResponse(raw: string): DaemonResponse {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'res' in parsed) {
      return parsed as DaemonResponse;
    }
  } catch {
    /* fall through */
  }
  return { res: 'error', message: `malformed daemon response: ${raw.slice(0, 200)}` };
}

/**
 * 编码一帧请求：4 字节小端长度 + JSON。超限抛错（调用方问题，应该炸出来）。
 */
export function encodeDaemonFrame(request: DaemonRequest): Buffer {
  const payload = Buffer.from(JSON.stringify(request), 'utf-8');
  if (payload.byteLength > DAEMON_MAX_FRAME) {
    throw new Error(`daemon frame too large: ${payload.byteLength} > ${DAEMON_MAX_FRAME}`);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(payload.byteLength, 0);
  return Buffer.concat([head, payload]);
}

/**
 * 从累积缓冲里解出一帧响应；不足一帧返回 null（调用方继续等数据）。
 * 返回 `[响应, 消耗字节数]`。
 */
export function decodeDaemonFrame(buf: Buffer): [DaemonResponse, number] | null {
  if (buf.byteLength < 4) return null;
  const len = buf.readUInt32LE(0);
  if (len > DAEMON_MAX_FRAME) {
    throw new Error(`daemon frame length ${len} exceeds limit ${DAEMON_MAX_FRAME}`);
  }
  if (buf.byteLength < 4 + len) return null;
  return [parseDaemonResponse(buf.subarray(4, 4 + len).toString('utf-8')), 4 + len];
}
