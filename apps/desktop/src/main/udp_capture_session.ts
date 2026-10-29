/**
 * 通用 UDP 抓包会话（主进程半边）。
 *
 * 与 `capture_session.ts`（QQNT / OIDB 抓包）刻意分开：那边是「按账号 → 找 pid →
 * 登记 SSO 物料拿 d2key → 解密 MSF 帧」，这边是「按进程 → 抓 UDP → 原样交给
 * 前端」，**不需要账号、不需要 d2key、不解析任何业务协议**。
 *
 * 两条提权路径沿用现成的：
 *   - 本进程有权限（Windows / root）：直接调 native；
 *   - 否则（Linux / macOS 普通用户）：走 `capture_elevation.ts` 的提权子进程。
 *
 * 归属管理比 TCP 那边简单：key 就是 pid，没有「同一账号换会话」的语义。
 */

import type { CapturedFrame, CaptureSupport, ProcessScanEntry } from '@weq/native';
import { resolveNtHelperPath } from '@weq/native';
import { getLogger } from '@weq/service';
import { requirePlatform } from './context/app_context';
import {
  toCaptureFrameWire,
  type CaptureBatchWire,
  type CaptureSessionWire,
  type CaptureStatsWire,
} from './capture_protocol';
import { startElevatedCaptureWorker, type ElevatedCaptureWorker } from './capture_elevation';

const logger = getLogger().child({ scope: 'udp-capture' });

/**
 * UDP 会话的环形缓冲默认帧数。
 *
 * native 的默认是 512，按 TCP/MSF 定的（一次请求/应答几帧）。实测视频通话是
 * **约 185 包/秒**（5 秒 926 包），512 帧只够缓冲 2.8 秒 —— 前端每 1 秒轮询
 * 一次虽然勉强够，但轮询一旦被主进程的其它活拖慢（渲染、导出、IPC 排队）就会
 * 立刻溢出，表现为 `dropped` 飞快上涨。
 *
 * 8192 帧 ≈ 44 秒的余量，代价是 8 MiB 级别的内存（单包约 1 KB）。
 */
const DEFAULT_UDP_RING_FRAMES = 8192;

/**
 * 单次 `takeFrames` 最多返回多少帧。
 *
 * native 默认 1024。185 包/秒下 1024 约等于 5.5 秒的吞吐，正常轮询（1 秒）远够；
 * 但页签切走再回来、或主进程卡顿时会攒下更多，给到 4096 减少「取不完」的等待。
 */
const DEFAULT_UDP_MAX_FRAMES = 4096;

/** 一次 UDP 抓包会话。 */
export interface UdpCaptureHandle {
  pid: number;
  sessionId: string;
  elevated: boolean;
  session: CaptureSessionWire;
}

/** pid → 提权子进程。与 `capture_session.ts` 的同名表分开，互不干扰。 */
const elevatedWorkers = new Map<number, ElevatedCaptureWorker>();

/** 同 pid 的 start/stop 串行化，避免长轮询期间会话被替换。 */
const queues = new Map<number, Promise<unknown>>();
/** 当前有效的会话 id（按 pid）。 */
const sessionIds = new Map<number, string>();
let sequence = 0;

function nextSessionId(): string {
  sequence += 1;
  return `udp-${Date.now().toString(36)}-${sequence}`;
}

async function exclusive<T>(pid: number, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(pid) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  queues.set(pid, settled);
  void settled.then(() => {
    if (queues.get(pid) === settled) queues.delete(pid);
  });
  return result;
}

/** UDP 抓包后端可用性（连同「产物里有没有这个能力」一起探）。 */
export function probeUdpCaptureBackend(): CaptureSupport {
  const nt = requirePlatform().native.ntHelper;
  if (typeof nt.probeCaptureSupport !== 'function') {
    return {
      available: false,
      backend: 'missing',
      elevated: false,
      hint: '当前 nt_helper 原生模块不含抓包接口，请 `pnpm native:fetch --latest` 取一份新构建。',
    };
  }
  return nt.probeCaptureSupport();
}

/** 进程扫描是否可用（老产物没有 `listProcessesWithModule`）。 */
export function probeProcessScan(): boolean {
  return typeof requirePlatform().native.ntHelper.listProcessesWithModule === 'function';
}

/**
 * 列出加载了指定模块的进程。
 *
 * `moduleHint` 传 `avsdk` 就是「找 QQ 的通话媒体进程」。提权不是必需的（读
 * `/proc/<pid>/maps` 只需要同用户权限），但提权子进程里也能跑 —— 这里优先用
 * 主进程，失败再交给提权路径。
 */
export function listProcessesWithModule(moduleHint: string): ProcessScanEntry[] {
  const nt = requirePlatform().native.ntHelper;
  if (typeof nt.listProcessesWithModule !== 'function') {
    throw new Error('当前原生模块不支持进程扫描，请更新原生组件');
  }
  return nt.listProcessesWithModule(moduleHint);
}

/**
 * 起一次 UDP 抓包会话。
 *
 * `pid` 是目标进程；`iface` / `port` 省略即 `auto`（自动选网卡 / 收全部端口）。
 * 注意：**会话要在目标进程创建 UDP socket 之前 armed**，否则 Linux 的
 * `cgroup/sendmsg` 钩子看不到那个 socket（详见 nt_helper 的 BPF 注释）。
 */
export async function startUdpCapture(
  pid: number,
  opts: { iface?: string; port?: string; ringFrames?: number } = {},
): Promise<UdpCaptureHandle> {
  const platform = requirePlatform();
  const support = probeUdpCaptureBackend();
  if (!support.available) throw new Error(support.hint || 'UDP 抓包后端不可用');

  return exclusive(pid, async () => {
    // 同 pid 已有会话先停掉（幂等重开）。
    // 注意：不能调 `stopUdpCapture` —— 它自己也要拿同一把串行锁，会自锁。
    await releaseSession(pid);

    const sessionId = nextSessionId();
    sessionIds.set(pid, sessionId);
    const options = {
      iface: opts.iface,
      port: opts.port,
      // ⚠️ 必须显式给：native 的默认是 512，那是按 TCP（一次请求/应答几帧）
      // 定的。UDP 通话每秒几百包，512 帧只够缓冲一两秒，前端一轮询就被挤掉
      // 一半 —— 表现为 dropped 飞快上涨。这里按 UDP 的速率给默认值。
      ringFrames: opts.ringFrames ?? DEFAULT_UDP_RING_FRAMES,
      transport: 'udp' as const,
    };

    try {
      if (support.elevated) {
        // 本进程已有权限（Windows 管理员 / root）：直接抓。
        const session = await platform.native.ntHelper.startCapture(pid, options);
        return { pid, sessionId, elevated: false, session };
      }
      const worker = await acquireElevatedWorker(pid);
      const session = await worker.request<CaptureSessionWire>({
        op: 'start',
        pid,
        iface: opts.iface,
        port: opts.port,
        ringFrames: opts.ringFrames,
        transport: 'udp',
      });
      return { pid, sessionId, elevated: true, session };
    } catch (error) {
      sessionIds.delete(pid);
      throw error;
    }
  });
}

/** 拉一批新增的数据报（长轮询）。 */
export async function takeUdpDatagrams(
  pid: number,
  opts: { cursor?: number; waitMs?: number; sessionId?: string } = {},
): Promise<CaptureBatchWire> {
  const current = sessionIds.get(pid);
  if (!current) throw new Error('该进程没有正在进行的 UDP 抓包会话');
  if (opts.sessionId && opts.sessionId !== current) {
    throw new Error('抓包会话已失效，请重新开始');
  }
  const elevated = elevatedWorkers.get(pid);
  if (elevated) {
    return await elevated.request<CaptureBatchWire>({
      op: 'take',
      pid,
      cursor: opts.cursor,
      waitMs: opts.waitMs,
      maxFrames: DEFAULT_UDP_MAX_FRAMES,
    });
  }
  const batch = await requirePlatform().native.ntHelper.takeFrames(pid, {
    cursor: opts.cursor,
    maxFrames: DEFAULT_UDP_MAX_FRAMES,
    waitMs: opts.waitMs,
  });
  return {
    frames: batch.frames.map(toCaptureFrameWire),
    nextCursor: batch.nextCursor,
    dropped: batch.dropped,
    kernelLost: batch.kernelLost,
  };
}

/**
 * 真正释放某 pid 的后端会话（**调用方必须已持有该 pid 的串行锁**）。
 *
 * 单独拆出来是为了让 `startUdpCapture` 能在自己的 `exclusive` 里复用 —— 直接
 * 调 `stopUdpCapture` 会重复拿同一把锁而死锁。
 */
async function releaseSession(pid: number): Promise<CaptureStatsWire | null> {
  sessionIds.delete(pid);
  const elevated = elevatedWorkers.get(pid);
  if (elevated) {
    elevatedWorkers.delete(pid);
    try {
      return await elevated.request<CaptureStatsWire>({ op: 'stop', pid });
    } catch (error) {
      logger.warn('提权 UDP 抓包停止失败', { error: String(error) });
      return null;
    } finally {
      elevated.dispose();
    }
  }
  try {
    return await requirePlatform().native.ntHelper.stopCapture(pid);
  } catch (error) {
    logger.warn('UDP 抓包停止失败', { error: String(error) });
    return null;
  }
}

/** 停止 UDP 抓包并释放会话（幂等）。 */
export async function stopUdpCapture(
  pid: number,
  sessionId?: string,
): Promise<CaptureStatsWire | null> {
  const current = sessionIds.get(pid);
  // 身份不符：不动别人的会话。
  if (sessionId && current && sessionId !== current) return null;
  // 本来就没有会话：直接返回，不进锁（避免无谓排队）。
  if (!current) return null;
  return exclusive(pid, async () => {
    // 排队期间可能已被替换成新会话 —— 再核一次身份。
    if (sessionId && sessionIds.get(pid) !== sessionId) return null;
    return await releaseSession(pid);
  });
}

/** 退出时释放所有提权子进程。 */
export function disposeUdpCaptures(): void {
  for (const [, worker] of elevatedWorkers) worker.dispose();
  elevatedWorkers.clear();
  sessionIds.clear();
}

async function acquireElevatedWorker(pid: number): Promise<ElevatedCaptureWorker> {
  const existing = elevatedWorkers.get(pid);
  if (existing) return existing;
  const worker = await startElevatedCaptureWorker(resolveNtHelperPath());
  elevatedWorkers.set(pid, worker);
  return worker;
}

/** 供导出层复用：把一帧拍平成可序列化的 wire 形态。 */
export type { CapturedFrame };
