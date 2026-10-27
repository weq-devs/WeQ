/**
 * 旧 weq-daemon 管道客户端 —— **仅用于升级退役**。
 *
 * 独立守护进程已移除，GUI 不再拉起、不再轮询、不再通过它托管 HTTP 或自启。
 * 这里只剩两个能力：`pingDaemon()` 探活、`daemonStop()` 让旧进程退出。
 * `apps/desktop/src/main/legacy_daemon.ts` 的迁移流程会在清掉旧注册后调用它们，
 * 确认旧后台真的不在了。
 *
 * 连接失败返回 `null` 而不是抛错 —— 「旧守护进程没在」是常态路径
 * （全新安装 / 已经退役过），由调用方决定怎么兜底。
 *
 * 客户端用法与旧 Rust 侧 `pipe.rs call_once` 严格对齐：连上 → 发一帧 →
 * 读到一帧或 EOF（`stop` 命令预期 EOF）→ 关闭。
 */

import { connect } from 'node:net';

import { daemonPipePath, decodeDaemonFrame, encodeDaemonFrame, DAEMON_PIPE_NAME } from './protocol';
import type { DaemonRequest, DaemonResponse } from './protocol';

/** 单次调用的默认超时（守护进程是本机进程，超时基本等于挂了）。 */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * 向旧守护进程发送一个请求并等待响应。管道不通返回 null（不抛）。
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

/** 探活：旧守护进程活着返回其版本；不活着返回 null。 */
export async function pingDaemon(
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<{ version: string; httpRunning: boolean } | null> {
  const res = await callDaemon({ cmd: 'ping' }, pipeName);
  return res?.res === 'pong' ? { version: res.version, httpRunning: res.http_running } : null;
}

/**
 * 停止旧守护进程本体（`stop`）：服务端先停掉自己的 HTTP，再直接退出进程。
 * 本来就不在时返回 false（幂等，不视为错误）。
 */
export async function daemonStop(pipeName: string = DAEMON_PIPE_NAME): Promise<boolean> {
  const res = await callDaemon({ cmd: 'stop' }, pipeName);
  return res?.res === 'stopped';
}
