/**
 * 守护进程健康 / release 监控 / 自启动 的聚合查询（bootstrap router 用）。
 *
 * 「健康性」= 一次管道往返能拿到的全部事实：
 *   - 进程在不在（ping 成功与否）+ 守护进程版本；
 *   - HTTP 服务状态（运行 / 端口 / docroot）；
 *   - release 轮询状态（watching / 最近错误 / pending）；
 *   - GUI 自启动注册状态（意图 + 平台实际在位）。
 *
 * 全部只读、无副作用：设置页可以随便轮询，不需要任何「开始/停止」。
 */

import {
  pingDaemon,
  daemonHttpStatus,
  daemonReleaseWatchStatus,
  daemonAutostartStatus,
  DAEMON_PIPE_NAME,
  getHost,
} from '@weq/service';

/** {@link getDaemonHealth} 的返回形状。 */
export interface DaemonHealth {
  /** 守护进程可探活（管道连通）。 */
  alive: boolean;
  /** 守护进程自身版本（alive 时有效）。 */
  version: string | null;
  /** 当前宿主是否允许设置开机自启（浏览器版 / 开发模式 = false）。 */
  autostartSupported: boolean;
  http: {
    running: boolean;
    port: number | null;
    docroot: string | null;
  } | null;
  release: {
    watching: boolean;
    repo: string | null;
    intervalSecs: number | null;
    currentVersion: string | null;
    latestSeen: string | null;
    /** 未确认的新版本（GUI 需要提醒的）。 */
    pending: string | null;
    /** 最近一次 GitHub 轮询错误（null = 正常）。 */
    lastError: string | null;
  } | null;
  autostart: {
    /** WeQ 设置的意图（守护进程记忆）。 */
    enabled: boolean;
    /** 平台注册实际在位（不一致 = 需要同步）。 */
    registered: boolean;
  } | null;
}

/**
 * 一次聚合的守护进程健康快照。守护进程不在时 alive=false，其余子项为
 * null（设置页显示「守护进程未运行」，并给出拉起指引）。
 */
export async function getDaemonHealth(): Promise<DaemonHealth> {
  const autostartSupported = getHost().canAutostart;
  const pong = await pingDaemon(DAEMON_PIPE_NAME);
  if (!pong) {
    return {
      alive: false,
      version: null,
      autostartSupported,
      http: null,
      release: null,
      autostart: null,
    };
  }
  const [http, release, autostart] = await Promise.all([
    daemonHttpStatus(DAEMON_PIPE_NAME),
    daemonReleaseWatchStatus(DAEMON_PIPE_NAME),
    daemonAutostartStatus(DAEMON_PIPE_NAME),
  ]);
  return {
    alive: true,
    version: pong.version,
    autostartSupported,
    http: http ? { running: http.running, port: http.port, docroot: http.docroot } : null,
    release: release
      ? {
          watching: release.watching,
          repo: release.repo,
          intervalSecs: release.interval_secs,
          currentVersion: release.current_version,
          latestSeen: release.latest_seen,
          pending: release.pending,
          lastError: release.last_error,
        }
      : null,
    autostart: autostart ?? null,
  };
}
