/**
 * weq-daemon 运行时编排（Electron 主进程专用）。
 *
 * 职责边界（刻意收窄）：
 *   - 保证守护进程「在」：探活，不在则以 detached 进程拉起 `<exe> serve`；
 *     【永远不主动杀掉守护进程】—— 它的生命周期属于开机自启 / 用户，不属于 GUI。
 *     设置开关 OFF 只发 `http_stop`（守护进程继续活着、记忆清空）。
 *   - 替调用方把 http_start / http_stop 讲给守护进程（含端口回落试探）。
 *   - 二进制路径解析：与 native/ 完全同构的 `daemon/<platform>-<arch>/` 布局。
 *
 * 端口 / docroot 一律由调用方传入，本模块不持有任何业务配置。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  callDaemon,
  daemonHttpStart,
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
 * 解析 weq-daemon 二进制的绝对路径；找不到返回 null。
 *
 * 打包布局（electron-builder `extraResources: from ../../resources → to resources`）：
 *   `<install>/resources/daemon/<platform>-<arch>/weq-daemon[.exe]`
 * 其中 `process.resourcesPath/resources` 正是 {@link resolveResource} 的根。
 * 开发布局：直接从本文件位置向上找仓库的 `resources/daemon/`。
 *
 * 候选顺序（第一个存在者胜出）：
 *   1. `WEQ_DAEMON_DIR` 环境变量（显式覆盖，指向 `daemon/<platform>-<arch>/` 那一层）
 *   2. `resolveResource('daemon', platformArch)`  — 打包（Electron resources 根）
 *   3. 沿 out/main 向上走最多 6 层找 `resources/daemon/<platformArch>` — 开发
 */
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
 * 确保守护进程在运行：探活 → 不在则 detached 拉起 `<exe> serve` → 轮询管道就绪。
 *
 * 拉起用的是独立进程（`detached: true` + `unref()`）：WeQ 退出它照常活着，
 * 而且它是『别人的』进程 —— 本函数从不调用 kill。
 *
 * 返回 true = 管道可用了（无论是本来就活着还是刚被拉起）。
 */
export async function ensureDaemonRunning(pipeName: string = DAEMON_PIPE_NAME): Promise<boolean> {
  // 已在 → 直接收工。
  if (await pingDaemon(pipeName)) return true;

  const exe = resolveDaemonBinary();
  if (!exe) {
    throw new Error(
      '找不到 weq-daemon 二进制（resources/daemon/<platform>-<arch>/）。请先运行 pnpm build:daemon。',
    );
  }
  // serve 模式：常驻等命令。stdio 全部丢弃 —— 守护进程自己写 stderr 日志，
  // 独立进程也拿不到 GUI 的 console。
  const child = spawn(exe, ['serve', '--pipe', pipeName], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await pingDaemon(pipeName)) return true;
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POLL_INTERVAL_MS));
  }
  return false;
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
