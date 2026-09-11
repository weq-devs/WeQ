/**
 * weq-daemon 统一管道客户端 —— GUI 侧所有守护进程通信的唯一入口。
 *
 * 设计目标（对应「统一 pipe 服务」的要求）：
 *   - 与具体业务解耦：`callDaemon(pipeName, request)` 收发任意
 *     {@link DaemonRequest}，新命令字零成本接入；
 *   - 常用命令给薄封装（ping / httpStart / httpStop / httpStatus / stop），
 *     调用方不必碰协议细节；
 *   - 连接失败返回 `null` 而不是抛错 —— 「守护进程没在」是常态路径
 *     （开机自启还没拉起 / 刚装完还没登录），由调用方决定怎么兜底。
 *
 * 客户端用法与 Rust 侧 `pipe.rs call_once` 严格对齐：连上 → 发一帧 → 读到
 * 一帧或 EOF（`stop` 命令预期 EOF）→ 关闭。
 */

import { connect } from 'node:net';

import { daemonPipePath, decodeDaemonFrame, encodeDaemonFrame, DAEMON_PIPE_NAME } from './protocol';
import type { DaemonReleaseWatchInfo, DaemonRequest, DaemonResponse } from './protocol';

/** 线上的 `release_watch_status` 帧（`res` 与载荷字段同层平铺）。 */
type ReleaseWatchStatusFrame = Extract<DaemonResponse, { res: 'release_watch_status' }>;

/**
 * 把平铺的状态帧收敛成纯 {@link DaemonReleaseWatchInfo}：serde 内部 tag 会把
 * newtype 变体里的结构体字段平铺到 `res` 同层，这里显式挑字段，不把协议层的
 * `res` 泄漏给调用方。
 */
function releaseInfo(frame: ReleaseWatchStatusFrame): DaemonReleaseWatchInfo {
  return {
    watching: frame.watching,
    repo: frame.repo,
    interval_secs: frame.interval_secs,
    current_version: frame.current_version,
    latest_seen: frame.latest_seen,
    pending: frame.pending,
    last_error: frame.last_error,
  };
}

/** 单次调用的默认超时（守护进程是本机进程，超时基本等于挂了）。 */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * 向守护进程发送一个请求并等待响应。管道不通返回 null（不抛）。
 * `stop` 命令读到 EOF 也算成功（服务端故意不回帧）。
 */
export function callDaemon(
  request: DaemonRequest,
  pipeName: string = DAEMON_PIPE_NAME,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DaemonResponse | null> {
  return new Promise((resolve) => {
    const socket = connect(daemonPipePath(pipeName));
    let settled = false;
    const finish = (value: DaemonResponse | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    socket.on('connect', () => {
      socket.write(encodeDaemonFrame(request));
    });
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const decoded = decodeDaemonFrame(buf);
        if (decoded) {
          clearTimeout(timer);
          finish(decoded[0]);
        }
      } catch (error) {
        clearTimeout(timer);
        finish({
          res: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    socket.on('error', () => {
      clearTimeout(timer);
      finish(null); // ENOENT / ECONNREFUSED = daemon 没跑，常态路径
    });
    // EOF：stop 命令的预期行为；其它命令视为无响应。
    socket.on('close', (hadError) => {
      clearTimeout(timer);
      if (request.cmd === 'stop') {
        finish({ res: 'stopped' });
      } else if (!settled) {
        finish(
          hadError
            ? null
            : { res: 'error', message: 'daemon closed the connection without a response' },
        );
      }
    });
  });
}

/** 探活：守护进程活着返回其版本与 HTTP 状态；不活着返回 null。 */
export async function pingDaemon(
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<{ version: string; httpRunning: boolean } | null> {
  const res = await callDaemon({ cmd: 'ping' }, pipeName);
  return res?.res === 'pong' ? { version: res.version, httpRunning: res.http_running } : null;
}

/**
 * 开启（或替换）守护进程上的静态 HTTP 服务。成功返回实际监听端口
 * （与请求一致；守护进程不落端口回落，回落逻辑在 GUI 例试探）。
 * 失败返回 null（守护进程不在）或 `{ ok: false, message }`（bind 失败等）。
 */
export async function daemonHttpStart(
  port: number,
  docroot: string,
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<{ ok: true; port: number } | { ok: false; message: string } | null> {
  const res = await callDaemon({ cmd: 'http_start', port, docroot }, pipeName);
  if (res === null) return null;
  if (res.res === 'started') return { ok: true, port: res.port };
  return { ok: false, message: res.res === 'error' ? res.message : `unexpected: ${res.res}` };
}

/**
 * 关闭守护进程上的 HTTP 服务（守护进程本体继续活着，记忆也被清除）。
 * 守护进程不在时也返回 true —— 调用方语义是「HTTP 不在了」。
 */
export async function daemonHttpStop(pipeName: string = DAEMON_PIPE_NAME): Promise<boolean> {
  const res = await callDaemon({ cmd: 'http_stop' }, pipeName);
  return res !== null && (res.res === 'stopped' || res.res === 'error');
}

/** 查询守护进程当前 HTTP 服务状态；守护进程不在返回 null。 */
export async function daemonHttpStatus(
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<{ running: boolean; port: number | null; docroot: string | null } | null> {
  const res = await callDaemon({ cmd: 'http_status' }, pipeName);
  if (res?.res !== 'http_status') return null;
  return { running: res.running, port: res.port, docroot: res.docroot };
}

/**
 * 开启（或按新参数重启）GitHub release 轮询。返回开启后的完整状态；
 * 守护进程不在返回 null。
 */
export async function daemonReleaseWatchStart(
  cfg: import('./protocol').DaemonReleaseWatchConfig,
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<import('./protocol').DaemonReleaseWatchInfo | null> {
  // 配置字段必须平铺（serde 内部 tag 的 newtype 变体），见 protocol.ts 的说明。
  const res = await callDaemon({ cmd: 'release_watch_start', ...cfg }, pipeName);
  return res?.res === 'release_watch_status' ? releaseInfo(res) : null;
}

/** 关闭 release 轮询（latest_seen / pending 保留）。 */
export async function daemonReleaseWatchStop(
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<boolean> {
  const res = await callDaemon({ cmd: 'release_watch_stop' }, pipeName);
  return res !== null && (res.res === 'stopped' || res.res === 'error');
}

/** 查询 release 轮询状态（含未确认的新版本）；守护进程不在返回 null。 */
export async function daemonReleaseWatchStatus(
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<import('./protocol').DaemonReleaseWatchInfo | null> {
  const res = await callDaemon({ cmd: 'release_watch_status' }, pipeName);
  return res?.res === 'release_watch_status' ? releaseInfo(res) : null;
}

/**
 * GUI 已处理某版本（弹窗已展示 / 推文已同步）→ 清 pending 并推进
 * current_version，下一轮不再重复置位。
 */
export async function daemonReleaseAck(
  version: string,
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<import('./protocol').DaemonReleaseWatchInfo | null> {
  const res = await callDaemon({ cmd: 'release_ack', version }, pipeName);
  return res?.res === 'release_watch_status' ? releaseInfo(res) : null;
}

/**
 * 注册 / 撤销 WeQ GUI 的开机自启（写注册表 / plist / systemd unit，并落记忆）。
 * 注册失败（平台工具报错）返回 `{ ok: false, message }`。
 */
export async function daemonAutostartSet(
  memory: import('./protocol').DaemonAutostartMemory,
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<{ ok: true; enabled: boolean } | { ok: false; message: string } | null> {
  // 同 release_watch_start：memory 的字段平铺，不做嵌套。
  const res = await callDaemon({ cmd: 'autostart_set', ...memory }, pipeName);
  if (res === null) return null;
  if (res.res === 'autostart_applied') return { ok: true, enabled: res.enabled };
  return { ok: false, message: res.res === 'error' ? res.message : `unexpected: ${res.res}` };
}

/** 查询 GUI 自启动状态（意图 + 平台注册实际在位）；守护进程不在返回 null。 */
export async function daemonAutostartStatus(
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<{ enabled: boolean; registered: boolean } | null> {
  const res = await callDaemon({ cmd: 'autostart_status' }, pipeName);
  return res?.res === 'autostart_status'
    ? { enabled: res.enabled, registered: res.registered }
    : null;
}
