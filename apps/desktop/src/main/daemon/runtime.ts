/**
 * weq-daemon 运行时编排（Electron / Web 共用）。
 *
 * 职责边界（刻意收窄）：
 *   - 把随包发布的二进制 **stage 到稳定路径**（数据目录的 `bin/`）：只有稳定
 *     路径才能被写进原生自启注册 —— AppImage 每次运行挂到不同临时目录，注册
 *     指向包内路径的话重启即失效。
 *   - 保证守护进程「在，且是磁盘上那个版本」：探活 + 比版本，一致就什么都不做；
 *     版本变了才 `stop` 掉旧的、覆盖落位、再拉起新的；不在则 detached 拉起。
 *   - 平时【不主动杀掉守护进程】—— 它的生命周期属于系统自启 / 用户，不属于 GUI；
 *     设置开关 OFF 只发 `http_stop`（进程继续活着、记忆清空）。
 *   - 替调用方把 http_start / http_stop 讲给守护进程（含端口回落试探）。
 *   - 二进制路径解析：与 native/ 完全同构的 `daemon/<platform>-<arch>/` 布局。
 *
 * 端口 / docroot 一律由调用方传入，本模块不持有任何业务配置。
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  callDaemon,
  daemonAutostartSet,
  daemonAutostartStatus,
  daemonHttpStart,
  daemonStop,
  getHost,
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
  //
  // 只有「参与系统自启」的宿主（打包版桌面）才让守护进程把自启注册写进系统：
  // 开发态（pnpm dev）的二进制是仓库构建产物，浏览器版则是部署方用 systemd /
  // 计划任务托管 —— 都不该由我们再注册一份（见 Rust 侧 NO_AUTOSTART_ENV）。
  const env = { ...process.env };
  if (!getHost().canAutostart) env.WEQ_DAEMON_NO_AUTOSTART = '1';
  const child = spawn(exe, ['serve', '--pipe', pipeName], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
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

/** 守护进程的状态目录（与 daemon 的 `persist.rs::state_dir` 必须保持一致）。 */
function daemonStateDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? homedir(), 'weq-daemon');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'weq-daemon');
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'weq-daemon');
}

/**
 * 守护进程的**稳定落位** —— 原生自启注册只能指向这里。
 *
 * 包内路径不可靠：AppImage 每次运行挂到 `/tmp/.mount_xxx/…`，`tar.gz` 也可能是
 * 用户随便解压的临时目录。注册指向那些路径的话重启后 unit / task / plist 全部
 * Exec 失败（这正是曾经线上故障的直接原因）。
 */
export function stagedDaemonPath(): string {
  const exe = process.platform === 'win32' ? 'weq-daemon.exe' : 'weq-daemon';
  return join(daemonStateDir(), 'bin', exe);
}

/**
 * 把随包发布的二进制覆盖到 {@link stagedDaemonPath}。
 *
 * 同目录 `tmp` + `rename` 原子替换；失败不抛 —— 调用方退化成「本次会话直接用
 * 包内二进制」，只记日志（Windows 上目标被占用是唯一的常见失败原因，而调用方
 * 已经先 `stop` 了旧实例）。
 */
async function stageDaemonBinary(source: string, target: string): Promise<boolean> {
  const tmp = `${target}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, tmp);
    await chmod(tmp, 0o755);
    await rename(tmp, target);
    logger.info('weq-daemon staged', { event: 'daemon-staged', target });
    return true;
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    logger.warn('failed to stage weq-daemon binary', {
      event: 'daemon-stage-failed',
      target,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * 确保守护进程「在跑，而且是磁盘上那个版本」：
 *
 *   1. 包内二进制与稳定落位（{@link stagedDaemonPath}）比版本，不一致就 `stop`
 *      旧实例 → 覆盖落位（版本升级的完整流程）；
 *   2. 探活 + 读要用的那个二进制的版本（`--version`，两者并行）；
 *   3. 已在跑且版本一致 → 什么都不做（不重启、不重复拉起）；
 *   4. 已在跑但版本不同 → `stop` 掉旧的，等管道消失，再拉起新的；
 *   5. 不在 → 拉起新的。
 *
 * 为什么要 stage：原生自启注册只能指向稳定路径（AppImage 每次运行挂到不同的
 * 临时目录），所以真正被拉起、被注册的永远是稳定落位那份。
 *
 * 单例由守护进程自己兜底（重复 `serve` 会立刻退出），这里只负责「版本对齐」。
 * 守护进程的生命周期属系统自启 / 用户：平时从不主动杀它，只有版本变化才替换。
 * 旧进程 `stop` 前会保留状态文件，新进程 `serve` 启动时按记忆自行恢复 HTTP
 * （同端口 / 同 docroot），并用新路径幂等重写自启注册。
 *
 * 返回 true = 管道可用了（本来就是它 / 刚被拉起 / 刚被换新）。
 */
export async function ensureDaemonRunning(pipeName: string = DAEMON_PIPE_NAME): Promise<boolean> {
  const bundled = resolveDaemonBinary();
  if (!bundled) {
    throw new Error(
      '找不到 weq-daemon 二进制（resources/daemon/<platform>-<arch>/）。请先运行 pnpm build:daemon。',
    );
  }

  // WEQ_DAEMON_DIR 是显式指定二进制的逃生口（测试 / 排查）：用它时不 stage ——
  // 调用方要的就是它自己那个路径，也不想往数据目录写东西。
  const override = Boolean(process.env.WEQ_DAEMON_DIR);
  const staged = stagedDaemonPath();
  if (!override) {
    const [bundledVersion, stagedVersion] = await Promise.all([
      readDaemonBinaryVersion(bundled),
      existsSync(staged) ? readDaemonBinaryVersion(staged) : Promise.resolve(null),
    ]);
    if (bundledVersion !== null && bundledVersion !== stagedVersion) {
      // 版本变了（装了新包 / 重新 build）：先停掉旧实例（它可能正占着 staged
      // 文件），再覆盖落位。之后 daemon 的 `serve` 会用新路径幂等重写自启注册。
      logger.info('staging weq-daemon', {
        event: 'daemon-stage',
        bundledVersion,
        stagedVersion,
      });
      await stopDaemonAndWait(pipeName);
      if (!(await stageDaemonBinary(bundled, staged))) {
        logger.error('staging failed — falling back to the bundled binary for this session', {
          event: 'daemon-stage-unusable',
        });
      }
    }
  }

  const exe = !override && existsSync(staged) ? staged : bundled;
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

/**
 * 把「开机后拉起 WeQ」的意图同步给守护进程（GUI 每次启动做一次）。
 *
 * 只落记忆、不注册任何东西 —— 全机唯一的原生自启是守护进程自己那份（它
 * `serve` 时自注册）。这里的作用是**刷新 gui_exe**：记忆里存的是 GUI 二进制路径，
 * 换安装位置 / 重命名 / AppImage 换文件之后必须跟着更新，否则守护进程开机拉的是
 * 一个不存在的路径。
 */
export async function syncGuiAutostartIntent(pipeName: string = DAEMON_PIPE_NAME): Promise<void> {
  if (!getHost().canAutostart) return; // 开发态 / 浏览器版：GUI 没有正确的 exe 语义
  const status = await daemonAutostartStatus(pipeName);
  if (!status?.enabled) return;
  const guiExe = getHost().currentExePath();
  if (!guiExe) return;
  const result = await daemonAutostartSet({ enabled: true, gui_exe: guiExe }, pipeName);
  if (result === null) return;
  if (!result.ok) {
    logger.warn('failed to refresh gui autostart path', {
      event: 'daemon-gui-autostart-refresh-failed',
      message: result.message,
    });
    return;
  }
  logger.info('gui autostart path refreshed', {
    event: 'daemon-gui-autostart-refreshed',
    guiExe,
  });
}

/** 让守护进程对某个请求做一次裸调用（统一管道入口；供状态页 / 诊断 / 未来命令使用）。 */
export function callDaemonOnce(
  request: DaemonRequest,
  pipeName: string = DAEMON_PIPE_NAME,
): Promise<DaemonResponse | null> {
  return callDaemon(request, pipeName);
}
