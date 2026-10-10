/**
 * 账号网卡抓包会话（主进程半边）—— 供「妙妙工具」抓包面板与「在线语音转写」
 * 共用。把「登记 SSO 物料拿 d2key → arm 抓包（本进程 / 提权子进程）→ 取帧 /
 * 停会话」这套流程收口到一处，避免两处各写一份、行为漂移。
 *
 * 抓包要拿 d2key 才能把 TEA 密文解成明文。d2key 在两条路径上都要**显式传给
 * `startCapture`**：
 *   - 提权路径：子进程是**另一个 native 实例**，主进程 `setSsoSession` 注册的物料
 *     在它那边看不见，不传就永远解不出明文；
 *   - 本进程路径（Windows / 本来就是 root）：注册过的物料它能自己回退查到，但显式
 *     传参才不依赖那条回退 —— 少了这一句，Windows 上就是「有密文、没明文」。
 *
 * 在线实例解析（`resolveAccountRows` / `resolveOnlineInstances`）也放这里：抓包
 * 要按账号反查在线的 pid，妙妙工具面板也要同一份数据。
 */

import type { CaptureSupport, LoginAccount } from '@weq/native';
import { resolveNtHelperPath } from '@weq/native';
import {
  attachAndRegisterSsoSession,
  getLogger,
  registerSsoSessionFromStored,
  resolveDeviceGuid,
} from '@weq/service';
import { requireBootstrap, requirePlatform } from './context/app_context';
import { ensureUidForUin } from './ipc/routers/bootstrap';
import {
  toCaptureFrameWire,
  type CaptureBatchWire,
  type CaptureSessionWire,
  type CaptureStatsWire,
} from './capture_protocol';
import { startElevatedCaptureWorker, type ElevatedCaptureWorker } from './capture_elevation';

const logger = getLogger().child({ scope: 'capture-session' });

/**
 * 抓包后端可用性（**连同「产物里有没有抓包接口」一起探**）。
 *
 * `probeCaptureSupport` 是抓包能力落地之后才进 `nt_helper.node` 的。老产物（或
 * `native/pinned.json` 还没跟上含抓包的 release）里压根没有这个函数，直接调用会抛
 * `TypeError: probeCaptureSupport is not a function` —— 那既不像「缺 Npcap」，也没
 * 有引导，排查时会白绕一圈。这里统一收口：缺接口时返回一条**带引导的不可用结果**，
 * 调用方（抓包面板 / 在线转录 arm）把它当普通「不可用」展示即可。
 */
export function probeCaptureBackend(): CaptureSupport {
  const nt = requirePlatform().native.ntHelper;
  if (typeof nt.probeCaptureSupport !== 'function') {
    const npcap =
      process.platform === 'win32'
        ? 'Windows 抓包还需安装 Npcap（安装时勾选 WinPcap API-compatible Mode）：https://npcap.com/dist/'
        : '请 `pnpm native:fetch --latest` 取一份含抓包能力的构建。';
    return {
      available: false,
      backend: 'missing',
      elevated: false,
      hint: `当前 nt_helper 原生模块不含抓包接口（构建过旧，锚点未跟上含抓包的版本）。${npcap}`,
    };
  }
  return nt.probeCaptureSupport();
}

/** 一个历史账号 + 在线状态（抓包面板列表 / 在线实例汇总共用）。 */
export interface AccountCaptureRow {
  uin: string;
  uid: string;
  userName: string;
  avatarUrl: string;
  lastLoginAt: number;
  /** 该账号的 `nt_msg.db` 绝对路径；目录不存在时为 null。 */
  dbPath: string | null;
  /** 反查到的在线 QQ 进程 pid；离线时为 null。 */
  pid: number | null;
}

/** 逐账号容错解析在线状态（单个账号探测失败不拖垮整个列表）。 */
export async function resolveAccountRows(
  boot: ReturnType<typeof requireBootstrap>,
  platform: ReturnType<typeof requirePlatform>,
): Promise<AccountCaptureRow[]> {
  let accounts: LoginAccount[] = [];
  try {
    accounts = await boot.detect.listAccounts();
  } catch {
    return [];
  }
  const rows: AccountCaptureRow[] = [];
  for (const acc of accounts) {
    // linux 需要 uin→uid 映射才能解析账号目录；win32 是无操作。
    await ensureUidForUin(boot, acc.uin);
    let dbPath: string | null = null;
    let pid: number | null = null;
    try {
      dbPath = platform.ntMsgDbPath(acc.uin);
    } catch {
      dbPath = null;
    }
    try {
      pid = platform.resolveQqPid(acc.uin);
    } catch {
      pid = null;
    }
    rows.push({
      uin: acc.uin,
      uid: acc.uid,
      userName: acc.userName,
      avatarUrl: acc.avatarUrl,
      lastLoginAt: acc.lastLoginAt,
      dbPath,
      pid,
    });
  }
  return rows;
}

/** 汇总当前在线的 QQ 实例（按账号反查，pid 去重）。 */
export async function resolveOnlineInstances(
  boot: ReturnType<typeof requireBootstrap>,
  platform: ReturnType<typeof requirePlatform>,
): Promise<Array<{ pid: number; uin: string; uid: string }>> {
  const rows = await resolveAccountRows(boot, platform);
  const seen = new Set<number>();
  const instances: Array<{ pid: number; uin: string; uid: string }> = [];
  for (const row of rows) {
    if (row.pid !== null && row.uid && !seen.has(row.pid)) {
      seen.add(row.pid);
      instances.push({ pid: row.pid, uin: row.uin, uid: row.uid });
    }
  }
  return instances;
}

/**
 * 为一个在线实例登记 SSO 会话物料（读内存拿 a2/d2/d2key），并回带 d2key。
 * **优先复用本地账号配置里已存的物料**（a2 / d2 / d2key + pid）直接登记 —— 抓包
 * 只要 d2key，本地这份就是上次从同一个 pid 读到的，没必要为了它再撞一次提权门。
 * 只有物料缺失 / pid 对不上（QQ 重启过，密钥已失效）才回退读内存（可能触发提权）。
 */
export async function prepareCaptureSession(
  uin: string,
): Promise<{ pid: number; d2Key: string | undefined }> {
  const boot = requireBootstrap();
  const platform = requirePlatform();
  const instances = await resolveOnlineInstances(boot, platform);
  const inst = instances.find((i) => i.uin === uin);
  if (!inst) {
    throw new Error(`账号 ${uin} 当前没有在线的 QQ 实例，无法抓包`);
  }
  const guid = resolveDeviceGuid(platform.native.ntHelper, platform);

  const stored = boot.userConfig.listAccountConfigs().find((c) => c.uin === uin);
  const reused = await registerSsoSessionFromStored(
    platform.native.ntHelper,
    platform,
    inst.pid,
    inst.uin,
    {
      material: stored?.session,
      pid: stored?.qqPid ?? null,
      uid: stored?.uid ?? inst.uid,
      guid: stored?.guid ?? guid,
    },
  );
  if (reused) {
    logger.info('capture registered the native sso session from stored material', {
      event: 'capture-reuse-stored',
      pid: inst.pid,
      uin: inst.uin,
    });
    return { pid: inst.pid, d2Key: stored?.session?.d2Key };
  }

  const { material, registered } = await attachAndRegisterSsoSession(
    platform.native.ntHelper,
    platform,
    boot.attachHook,
    inst.pid,
    inst.uin,
    { uid: inst.uid, guid },
  );
  if (!material.d2Key) {
    logger.warn('capture started without d2key; frames will stay encrypted', {
      event: 'capture-no-d2key',
      pid: inst.pid,
      uin: inst.uin,
      registered,
    });
  }
  return { pid: inst.pid, d2Key: material.d2Key };
}

/**
 * 睁着的提权抓包子进程（一次抓包会话一个）。key = pid —— native 侧会话本身也是按
 * pid 记的，而取帧 / 停会话只带 pid，所以只能按 pid 找回子进程。
 */
const elevatedCaptures = new Map<number, ElevatedCaptureWorker>();

/** 取（或起）某 pid 的提权抓包子进程；需要密码时由它自己弹框。 */
export async function acquireElevatedCaptureWorker(pid: number): Promise<ElevatedCaptureWorker> {
  const existing = elevatedCaptures.get(pid);
  if (existing) return existing;
  const worker = await startElevatedCaptureWorker(resolveNtHelperPath());
  elevatedCaptures.set(pid, worker);
  return worker;
}

/** 关掉所有提权抓包子进程（退出 / 卸载会话时调用）。幂等。 */
export function disposeElevatedCaptures(): void {
  for (const [, worker] of elevatedCaptures) worker.dispose();
  elevatedCaptures.clear();
}

/** 一次已 armed 的账号抓包会话。 */
export interface AccountCaptureHandle {
  pid: number;
  /** true = 跑在提权子进程里；false = 主进程直接抓（Windows / 本来就是 root）。 */
  elevated: boolean;
  /** 是否拿到了 d2key（false 时只能看密文）。 */
  hasD2Key: boolean;
  session: CaptureSessionWire;
}

/**
 * 起一次账号抓包会话：先探测后端（Windows 缺 Npcap 会抛带引导的错），登记 SSO
 * 物料拿 d2key，再 arm 网卡。失败原因（缺 Npcap / 未提权 / 账号离线）原样抛出。
 */
export async function startAccountCapture(
  uin: string,
  opts: { iface?: string; port?: string } = {},
): Promise<AccountCaptureHandle> {
  const platform = requirePlatform();
  const support = probeCaptureBackend();
  if (!support.available) {
    throw new Error(support.hint || '抓包后端不可用');
  }
  const { pid, d2Key } = await prepareCaptureSession(uin);

  if (support.elevated || process.platform === 'win32') {
    const session = await platform.native.ntHelper.startCapture(pid, {
      iface: opts.iface,
      port: opts.port,
      // ⚠️ native 的字段名是 `d2Key`（napi 从 Rust `d2key` 转来）；写成小写
      // `d2key` 会被静默忽略 → 密文全部解不开。
      d2Key,
    });
    return { pid, elevated: false, hasD2Key: Boolean(d2Key), session };
  }

  const worker = await acquireElevatedCaptureWorker(pid);
  const session = await worker.request<CaptureSessionWire>({
    op: 'start',
    pid,
    iface: opts.iface,
    port: opts.port,
    d2key: d2Key,
  });
  return { pid, elevated: true, hasD2Key: Boolean(d2Key), session };
}

/** 拉一批新增帧（自动路由到提权子进程 / 本进程），hex 形态。 */
export async function takeAccountFrames(
  pid: number,
  opts: { cursor?: number; waitMs?: number } = {},
): Promise<CaptureBatchWire> {
  const elevated = elevatedCaptures.get(pid);
  if (elevated) {
    return await elevated.request<CaptureBatchWire>({
      op: 'take',
      pid,
      cursor: opts.cursor,
      waitMs: opts.waitMs,
    });
  }
  const platform = requirePlatform();
  const batch = await platform.native.ntHelper.takeFrames(pid, {
    cursor: opts.cursor,
    waitMs: opts.waitMs,
  });
  return {
    frames: batch.frames.map(toCaptureFrameWire),
    nextCursor: batch.nextCursor,
    dropped: batch.dropped,
  };
}

/** 停止抓包并释放会话（幂等：会话已不存在时返回 null）。 */
export async function stopAccountCapture(pid: number): Promise<CaptureStatsWire | null> {
  const elevated = elevatedCaptures.get(pid);
  if (elevated) {
    elevatedCaptures.delete(pid);
    try {
      return await elevated.request<CaptureStatsWire>({ op: 'stop', pid });
    } catch {
      return null;
    } finally {
      elevated.dispose();
    }
  }
  const platform = requirePlatform();
  try {
    return await platform.native.ntHelper.stopCapture(pid);
  } catch {
    return null;
  }
}
