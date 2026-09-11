/**
 * weq-daemon 运行时编排（Electron / Web 共用）。
 *
 * 职责边界（刻意收窄）：
 *   - 保证守护进程「在，且是磁盘上那个版本」：探活 + 比版本，一致就什么都不做；
 *     版本变了才 `stop` 掉旧的再拉起新的；不在则 detached 拉起 `<exe> serve`。
 *   - 平时【不主动杀掉守护进程】—— 它的生命周期属于开机自启 / 用户，不属于 GUI；
 *     设置开关 OFF 只发 `http_stop`（进程继续活着、记忆清空）。
 *   - 替调用方把 http_start / http_stop 讲给守护进程（含端口回落试探）。
 *   - 二进制路径解析：与 native/ 完全同构的 `daemon/<platform>-<arch>/` 布局。
 *
 * 端口 / docroot 一律由调用方传入，本模块不持有任何业务配置。
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  callDaemon,
  daemonHttpStart,
  daemonStop,
  getLogger,
  pingDaemon,
  DAEMON_PIPE_NAME,
  type DaemonRequest,
  type DaemonResponse,
} from '@weq/service';
import { resolveResource } from '../resource';

const here = dirname(fileURLToPath(import.meta.url));

/** 唤醒窗口：spawn `serve` 后等管道就绪的最长时间。 */
const SPAWN_READY_TIMEOUT_MS = 8000;
/** 探活轮询间隔。 */
const SPAWN_POLL_INTERVAL_MS = 200;
/**
 * 重试 spawn 的最小间隔：旧进程刚退出时管道可能还没释放（win32 的
 * first_pipe_instance 会立刻失败），所以唤醒窗口内不是只拉一次。
 */
const SPAWN_RETRY_INTERVAL_MS = 1500;
/** `stop` 之后等旧进程真正退出的最长时间。 */
const STOP_WAIT_TIMEOUT_MS = 5000;
/** 读二进制 `--version` 的超时。 */
const VERSION_PROBE_TIMEOUT_MS = 3000;

const execFileAsync = promisify(execFile);
const logger = getLogger().child({ scope: 'daemon-runtime' });

/** 从 `weq-daemon 1.0.0` 里取出 `1.0.0`；解析不出返回 null。 */
export function parseDaemonVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1] ?? null;
}

/**
 * 磁盘上那个二进制的版本号（`<exe> --version`）。读不到（权限 / 损坏 / 超时）返回
 * null —— 调用方据此跳过版本判定，只保证「在跑」。
 */
async function readDaemonBinaryVersion(exe: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(exe, ['--version'], {
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return parseDaemonVersion(String(stdout));
  } catch (error) {
    logger.warn('failed to read weq-daemon version from the binary', {
      event: 'daemon-version-probe-failed',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 发 `stop` 并等管道消失（旧进程一退出就算成功）。 */
async function stopDaemonAndWait(pipeName: string): Promise<void> {
  if (!(await daemonStop(pipeName))) return; // 本来就不在
  const deadline = Date.now() + STOP_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await pingDaemon(pipeName))) return;
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_INTERVAL_MS));
  }
  logger.warn('weq-daemon did not exit after stop', { event: 'daemon-stop-timeout' });
}

/** spawn `<exe> serve`（独立进程：WeQ 退出它照常活着）。 */
function spawnDaemonServe(exe: string, pipeName: string): void {
  // serve 模式：常驻等命令。stdio 全部丢弃 —— 守护进程自己写 stderr 日志；
  // 独立进程也拿不到 GUI 的 console。
  const child = spawn(exe, ['serve', '--pipe', pipeName], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

/**
 * 轮询管道就绪；窗口内按 {@link SPAWN_RETRY_INTERVAL_MS} 补拉，覆盖「旧进程刚
 * 退出、管道还没释放」的那一小段窗口。
 */
async function spawnDaemonAndWait(exe: string, pipeName: string): Promise<boolean> {
  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
  let nextSpawnAt = 0;
  for (;;) {
    if (await pingDaemon(pipeName)) return true;
    const now = Date.now();
    if (now >= deadline) return false;
    if (now >= nextSpawnAt) {
      nextSpawnAt = now + SPAWN_RETRY_INTERVAL_MS;
      spawnDaemonServe(exe, pipeName);
    }
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_INTERVAL_MS));
  }
}

export function resolveDaemonBinary(): string | null {
  const exe = process.platform === 'win32' ? 'weq-daemon.exe' : 'weq-daemon';
  const platformArch = `${process.platform}-${process.arch}`;

  const override = process.env.WEQ_DAEMON_DIR;
  if (override) {
    const candidate = join(override, exe);
    if (existsSync(candidate)) return candidate;
  }

  const packaged = resolveResource('daemon', platformArch, exe);
  if (packaged) return packaged;

  let dir = here;
  for (let i = 0; i < 6; i += 1) {
    const candidate = join(dir, 'resources', 'daemon', platformArch, exe);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 确保守护进程「在跑，而且是磁盘上那个版本」：
 *
 *   1. 探活 + 读磁盘二进制的版本（`--version`，两者并行）；
 *   2. 已在跑且版本一致 → 什么都不做（不重启、不重复拉起）；
 *   3. 已在跑但版本不同 → `stop` 掉旧的，等管道消失，再拉起新的；
 *   4. 不在 → 拉起新的。
 *
 * 单例由守护进程自己兜底（重复 `serve` 会立刻退出），这里只负责「版本对齐」。
 * 守护进程的生命周期仍属开机自启 / 用户：平时从不主动杀它，只有磁盘上的二进制
 * 换了版本才替换。旧进程 `stop` 前会保留状态文件，新进程 `serve` 启动时按记忆
 * 自行恢复 HTTP（同端口 / 同 docroot）。
 *
 * 返回 true = 管道可用了（本来就是它 / 刚被拉起 / 刚被换新）。
 */
export async function ensureDaemonRunning(pipeName: string = DAEMON_PIPE_NAME): Promise<boolean> {
  const exe = resolveDaemonBinary();
  if (!exe) {
    throw new Error(
      '找不到 weq-daemon 二进制（resources/daemon/<platform>-<arch>/）。请先运行 pnpm build:daemon。',
    );
  }

  const [expected, running] = await Promise.all([
    readDaemonBinaryVersion(exe),
    pingDaemon(pipeName),
  ]);

  if (running) {
    // 版本读不出来时保守处理：只保证「在跑」，不做替换。
    if (expected === null || running.version === expected) return true;
    logger.info('weq-daemon version changed, replacing the running one', {
      event: 'daemon-version-changed',
      running: running.version,
      expected,
    });
    await stopDaemonAndWait(pipeName);
  }

  return spawnDaemonAndWait(exe, pipeName);
}

export interface DaemonHttpStartResult {
  ok: boolean;
  /** 实际监听端口（ok 时有效）。 */
  port?: number;
  /** 失败原因（!ok 时有效）。 */
  message?: string;
}

/**
 * 开启（或按新参数替换）守护进程上的静态 HTTP 服务。若请求端口被占
 * （守护进程 bind 失败），自动向后试探至多 20 个端口 —— 与旧版内置
 * server.ts 的回落行为一致。返回最终绑定的端口。
 */
export async function startDaemonHttp(
  port: number,
  docroot: string,
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<DaemonHttpStartResult> {
  const PORT_FALLBACK_ATTEMPTS = 20;
  for (let attempt = 0; attempt < PORT_FALLBACK_ATTEMPTS; attempt += 1) {
    const candidate = Math.min(port + attempt, 65535);
    const result = await daemonHttpStart(candidate, docroot, pipeName);
    if (result === null) {
      return { ok: false, message: '守护进程不在运行，且无法连接控制管道' };
    }
    if (result.ok) return { ok: true, port: result.port };
    // bind 失败才回落；docroot 无效这类错误直接透传，不换端口重试。
    if (!result.message.includes('bind 127.0.0.1')) {
      return { ok: false, message: result.message };
    }
  }
  return { ok: false, message: `端口 ${port}–${port + PORT_FALLBACK_ATTEMPTS - 1} 都被占用` };
}

/** 让守护进程对某个请求做一次裸调用（统一管道入口；供状态页 / 诊断 / 未来命令使用）。 */
export function callDaemonOnce(
  request: DaemonRequest,
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<DaemonResponse | null> {
  return callDaemon(request, pipeName);
}
