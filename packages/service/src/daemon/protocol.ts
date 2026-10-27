/**
 * 旧 weq-daemon 控制管道协议 —— **仅用于升级退役**，不再有对应的服务端实现。
 *
 * 分帧：4 字节小端长度 + JSON（UTF-8）。单帧上限 1 MiB。
 * 请求 / 响应都是单帧；服务端每连接只处理一个请求后关闭。
 * `stop` 命令服务端不回帧（直接断开，客户端读 EOF 即成功）。
 *
 * 独立守护进程已移除，这里只保留退役迁移要用的最小命令集
 * （`ping` 探活 / `stop` 停止）。曾经的 http_* / release_watch_* /
 * autostart_* 命令已随服务端一起删除，不要在这里重新加回来。
 */

import { tmpdir } from 'node:os';

/** 默认管道名（旧守护进程的固定名字；状态文件也按它区分）。 */
export const DAEMON_PIPE_NAME = 'weq-daemon';

/** 单帧 JSON 上限（与旧服务端的 `MAX_FRAME` 一致）。 */
export const DAEMON_MAX_FRAME = 1024 * 1024;

/** 请求联合类型（旧服务端按 serde 内部 tag 解析，载荷平铺在同一层）。 */
export type DaemonRequest = { cmd: 'ping' } | { cmd: 'stop' };

export type DaemonResponse =
  | { res: 'pong'; version: string; http_running: boolean }
  | { res: 'stopped' }
  | { res: 'error'; message: string };

/** 控制管道的完整连接目标。 */
export function daemonPipePath(pipeName = DAEMON_PIPE_NAME): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\${pipeName}` // Windows named pipe
    : `${tmpdir()}/${pipeName}.sock`; // unix domain socket（与旧服务端 socket_path 一致）
}

/**
 * 把一帧响应 JSON 解析成 {@link DaemonResponse}；形状不符回 error 帧。
 * 对端是旧版本的本机进程，输入仍按不可信处理（坏帧不抛，可日志可上报）。
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
