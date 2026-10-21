/**
 * 借 QQ 凭据发包前的**唯一登记口**：把一次会话的内存物料（a2 / d2 / d2key）
 * 与身份（uin / uid / guid）交给原生侧（`setSsoSession`）。
 *
 * 为什么单独成模块：`sendOidbPacket` / `sendPacket` 只是「组帧 → 直连」，
 * 它们**不带凭据** —— native 侧按 pid 在一张表里找已登记的会话物料，找不到
 * 就报「pid X 还没有登记 SSO 会话」。所以任何「先取物料、再发包」的流程
 * （登录时的 0xcde_2 取密钥、维护与诊断工具的其它设备密钥、账号 monitor 的
 * rkey/clientkey 采集）都必须在发包前走这里登记一次，否则第一包必然失败。
 *
 * **只登记、不建连**：TCP 等到真要发包时才连；在线状态与心跳交给同机 QQ
 * 本体维持（见 `sso/client.rs` 的模块注释）。
 */

import { statSync } from 'node:fs';
import type { AppidInfo, NtHelperBinding, SessionMaterial } from '@weq/native';
import type { Platform } from '@weq/platform';
import type { AttachHook } from '../bootstrap/attach';
import { getLogger } from '../common/logger';
import { queueSsoWork, ssoWorkState } from './sso_lifecycle';

/**
 * 兜底 `subAppId`：**仅**在 `major.node` 读不出 appid 时用。
 *
 * ⚠️ 别把这里当真实值。`subAppId` 必须等于**当前运行那个 QQ 构建的 appid**
 * （`major.node` 里 `QQAppId/537xxxxxx`），否则服务端直接回
 * `-10003 身份验证失败`（`Reply status error: -10003`）。QQ 每次自动更新都
 * 会换 appid：9.9.35 是 `537382819`、9.9.36 是 `537391628`——这个旧常量
 * （`537391664`）对不上任何一个在用版本，所以每包必被拒。
 *
 * 正解见 {@link resolveSubAppId}：从 `major.node` 动态解析。
 */
export const PC_SUB_APP_ID = 537391664;

/**
 * 解析当前 QQ 构建的 appid，用作 SSO 的 `subAppId`。
 *
 * 优先从 `major.node` 动态扫描（`resolveAppidFromMajor`，与纯协议登录流程
 * 同源）。在线调用传入 PID 时，缺失或解析失败直接报错，禁止猜测身份；
 * 不带 PID 的旧离线调用保留兼容回退。
 */
export function resolveSubAppId(
  nt: Pick<NtHelperBinding, 'resolveAppidFromMajor'>,
  platform: Pick<Platform, 'qqMajorNodePath'>,
  pid?: number,
): number {
  const majorPath = platform.qqMajorNodePath(pid);
  if (!majorPath) {
    if (pid !== undefined) throw new Error('运行中 QQ 的 major.node 不可用，无法确认 App ID。');
    logger.warn('major.node not found; falling back to the kit subAppId', {
      event: 'subappid-major-missing',
      fallback: PC_SUB_APP_ID,
    });
    return PC_SUB_APP_ID;
  }
  try {
    const appid = Number(nt.resolveAppidFromMajor(majorPath).appid);
    if (Number.isSafeInteger(appid) && appid > 0) return appid;
    if (pid !== undefined) throw new Error('运行中 QQ 的 App ID 无效，未登记 SSO 会话。');
    logger.warn('major.node appid unparsable; falling back to the kit subAppId', {
      event: 'subappid-unparsable',
      majorPath,
      fallback: PC_SUB_APP_ID,
    });
  } catch (error) {
    if (pid !== undefined) throw error;
    logger.warn('resolveAppidFromMajor failed; falling back to the kit subAppId', {
      event: 'subappid-resolve-failed',
      majorPath,
      error: error instanceof Error ? error.message : String(error),
      fallback: PC_SUB_APP_ID,
    });
  }
  return PC_SUB_APP_ID;
}

/** 发包时服务端认的三件身份：账号 uin、账号 uid、设备 guid。 */
export interface SsoIdentity {
  /** 账号 UIN 十进制串。 */
  uin: string;
  /** 账号 uid（`u_...`）；服务端校验不过会回 `-10003 身份验证失败`。 */
  uid: string;
  /** 设备 guid（32 位小写 hex）；服务端认设备的依据。 */
  guid: string;
  /**
   * SSO 的 `subAppId`。省略时按 {@link resolveSubAppId} 从 `major.node`
   * 动态解析（正常情况下调用方都不该传，别再造一个硬编码）。
   */
  subAppId?: number;
  /** Explicit version override for tests or known client metadata. */
  clientVersion?: string;
}

export interface SsoClientSnapshot {
  pid: number;
  identity: SsoIdentity & { subAppId: number };
  majorPath: string | null;
  wrapperPath: string | null;
}

// Ephemeral file generations only; no database, credentials or persistent disk identity.
const clientMetadata = new WeakMap<object, Map<string, { stamp: string; info: AppidInfo }>>();
function moduleStamp(path: string | null): string | null {
  if (!path) return null;
  try {
    const stat = statSync(path, { bigint: true });
    return stat.isFile()
      ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
      : null;
  } catch {
    return null;
  }
}

/** Resolve all registration fields from one observed running-client metadata read. */
export function resolveSsoClientSnapshot(
  nt: Pick<NtHelperBinding, 'resolveAppidFromMajor'>,
  platform: Pick<Platform, 'qqWrapperNodePath' | 'qqMajorNodePath'>,
  pid: number,
  identity: SsoIdentity,
): SsoClientSnapshot {
  const majorPath = platform.qqMajorNodePath(pid);
  const wrapperPath = platform.qqWrapperNodePath(pid);
  let info: AppidInfo | undefined;
  if (identity.subAppId === undefined || !identity.clientVersion) {
    if (!majorPath && identity.subAppId === undefined)
      throw new Error('运行中 QQ 的 major.node 不可用，无法确认 App ID。');
    if (majorPath) {
      try {
        const key = JSON.stringify([pid, majorPath, wrapperPath]);
        const before = moduleStamp(majorPath);
        const cached = clientMetadata.get(nt)?.get(key);
        if (before && cached?.stamp === before) info = cached.info;
        else {
          info = nt.resolveAppidFromMajor(majorPath);
          const after = moduleStamp(majorPath);
          if (before !== after) throw new Error('QQ 模块在读取期间发生变化，请稍后重试。');
          if (after) {
            let entries = clientMetadata.get(nt);
            if (!entries) {
              entries = new Map();
              clientMetadata.set(nt, entries);
            }
            if (entries.size >= 64) entries.clear();
            entries.set(key, { stamp: after, info: { ...info } });
          }
        }
      } catch (error) {
        info = undefined;
        if (identity.subAppId === undefined) throw error;
      }
    }
  }
  const subAppId = identity.subAppId ?? Number(info?.appid);
  if (!Number.isSafeInteger(subAppId) || subAppId <= 0 || subAppId > 0xffff_ffff)
    throw new Error('SSO App ID 无效。');
  const clientVersion =
    identity.clientVersion ||
    (info?.version && info.build ? `${info.version}-${info.build}` : undefined);
  return {
    pid,
    identity: { ...identity, subAppId, ...(clientVersion ? { clientVersion } : {}) },
    majorPath,
    wrapperPath,
  };
}

const logger = getLogger().child({ scope: 'sso-session' });

/**
 * 从 QQ 数据根路径离线读取设备 guid（32 位小写 hex）。
 *
 * 不需要任何权限、不碰进程；三端算法不同，但都归 `nt.readDeviceGuid`。
 * 数据根还没解析出来（`null`）或算不出时返回 `null`。
 */
export function resolveDeviceGuid(
  nt: Pick<NtHelperBinding, 'readDeviceGuid'>,
  platform: Pick<Platform, 'qqDataRoot'>,
): string | null {
  const root = platform.qqDataRoot();
  if (!root) return null;
  try {
    return nt.readDeviceGuid(root) ?? null;
  } catch (error) {
    logger.warn('failed to read device guid', {
      event: 'read-device-guid-failed',
      root,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 把物料转成 native 要的 Buffer 形态；任一字段缺失返回 `null`。 */
function materialToBuffers(
  material: SessionMaterial,
): { a2: Buffer; d2: Buffer; d2Key: Buffer } | null {
  const validHex = (value: string | undefined): value is string =>
    typeof value === 'string' && /^(?:[0-9a-fA-F]{2})+$/.test(value);
  if (!validHex(material.a2) || !validHex(material.d2) || !validHex(material.d2Key)) return null;
  if (material.d2Key.length !== 32) return null;
  return {
    a2: Buffer.from(material.a2, 'hex'),
    d2: Buffer.from(material.d2, 'hex'),
    d2Key: Buffer.from(material.d2Key, 'hex'),
  };
}

/**
 * 登记 `pid` 的会话物料，之后 `sendOidbPacket` / `sendPacket` 就能借它发包。
 *
 * 物料不全（缺 a2 / d2 / d2key）或身份不全（缺 uid / guid）时**不登记**并
 * 返回 `false` —— 缺 uid 服务端会以 `-10003` 拒绝，缺 guid 更是不认这台设备，
 * 与其发一包必失败的请求，不如让调用方拿到明确的「物料不齐」。
 */
export function registerSsoSession(
  nt: Pick<NtHelperBinding, 'setSsoSession' | 'resolveAppidFromMajor'>,
  platform: Pick<Platform, 'qqWrapperNodePath' | 'qqMajorNodePath'>,
  pid: number,
  identity: SsoIdentity,
  material: SessionMaterial,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  return queueSsoWork(nt, pid, async () => {
    const registered = await registerSsoSessionInTurn(
      nt,
      platform,
      pid,
      identity,
      material,
      isCurrent,
    );
    // A successful non-monitor registration replaces the previous lease too.
    // Old monitors must neither reuse its fingerprint nor clear its session.
    if (registered) ssoWorkState(nt, pid).owner = {};
    return registered;
  });
}

/** Internal: caller must already hold queueSsoWork through registration and ownership publication. */
export async function registerSsoSessionInTurn(
  nt: Pick<NtHelperBinding, 'setSsoSession' | 'resolveAppidFromMajor'>,
  platform: Pick<Platform, 'qqWrapperNodePath' | 'qqMajorNodePath'>,
  pid: number,
  identity: SsoIdentity,
  material: SessionMaterial,
  isCurrent: () => boolean = () => true,
  snapshot?: SsoClientSnapshot,
): Promise<boolean> {
  const buffers = materialToBuffers(material);
  if (!buffers || !identity.uid || !identity.guid) {
    logger.warn('session material incomplete; native transport not configured', {
      event: 'set-sso-session-skipped',
      pid,
      hasA2: material.a2 !== undefined,
      hasD2: material.d2 !== undefined,
      hasD2Key: material.d2Key !== undefined,
      hasUid: Boolean(identity.uid),
      hasGuid: Boolean(identity.guid),
    });
    return false;
  }

  try {
    if (!isCurrent()) return false;
    const client = snapshot ?? resolveSsoClientSnapshot(nt, platform, pid, identity);
    if (
      client.pid !== pid ||
      client.identity.uin !== identity.uin ||
      client.identity.uid !== identity.uid ||
      client.identity.guid !== identity.guid
    )
      throw new Error('SSO 客户端快照与账号会话不匹配。');
    const { subAppId, clientVersion } = client.identity;

    if (!isCurrent()) return false;
    await nt.setSsoSession(
      pid,
      {
        uin: identity.uin,
        a2: buffers.a2,
        d2: buffers.d2,
        d2Key: buffers.d2Key,
        guid: identity.guid,
        uid: identity.uid,
        subAppId,
        ...(clientVersion ? { clientVersion } : {}),
      },
      client.wrapperPath,
    );
    logger.info('stored session material for the native sso transport', {
      event: 'set-sso-session',
      pid,
      uin: identity.uin,
      subAppId,
    });
    return true;
  } catch (error) {
    logger.warn('failed to store session material for the native transport', {
      event: 'set-sso-session-failed',
      pid,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/** 本地账号配置里存着、可直接复用的会话物料 + 身份。 */
export interface StoredSsoMaterial {
  /** 本地缓存的会话物料（a2 / d2 / d2key + 读它时的 pid）；缺一不可。 */
  material?: { a2?: string; d2?: string; d2Key?: string; pid?: number } | null;
  /**
   * 物料归属的 pid —— 仅当 `material.pid` 缺失（老记录）时用作兜底判据。
   * 只能取「独立于本次调用」的来源（如账号 config 里记的 `qqPid`），**绝不能**
   * 是刚刚被本次流程写成当前 pid 的值，否则判据恒真、失去意义。
   */
  pid?: number | null;
  /** 账号 uid（`u_...`）。 */
  uid?: string | null;
  /** 设备 guid（32 位小写 hex）。 */
  guid?: string | null;
}

/**
 * 直接用本地账号配置里**已经存下的**会话物料登记原生 SSO 会话 —— **不读内存、
 * 不提权**。这是「本地凭据齐全时不再弹提权」的落点。
 *
 * 只在物料三件套齐全、身份齐全、且这份物料正是从 `pid` 读出来（`material.pid`
 * 或兜底的 `stored.pid` === `pid`）时才复用：pid 对不上说明 QQ 重启过、旧密钥已随
 * 旧进程失效，这时返回 `false`，交给调用方回退到读内存那条路。
 *
 * 返回 `true` = 已登记，`false` = 没登记（调用方继续 attach）。`setSsoSession`
 * 自身抛错时也返回 `false`（{@link registerSsoSession} 内部已兜底）。
 */
export async function registerSsoSessionFromStored(
  nt: Pick<NtHelperBinding, 'setSsoSession' | 'resolveAppidFromMajor'>,
  platform: Pick<Platform, 'qqWrapperNodePath' | 'qqMajorNodePath'>,
  pid: number,
  uin: string,
  stored: StoredSsoMaterial,
): Promise<boolean> {
  const { material } = stored;
  if (!material?.a2 || !material.d2 || !material.d2Key) return false;
  // session.pid 是权威判据；老记录没有它时退到调用方给的 pid（见 StoredSsoMaterial.pid）。
  if ((material.pid ?? stored.pid ?? null) !== pid) return false;
  const uid = stored.uid ?? '';
  const guid = stored.guid ?? '';
  if (!uid || !guid) return false;
  return registerSsoSession(nt, platform, pid, { uin, uid, guid }, material);
}

/**
 * 一次把「读内存拿物料」和「登记 SSO 会话」做完 —— 所有「先 attach 再发包」
 * 的流程（登录取密钥、维护与诊断工具的其它设备密钥、账号 monitor 采集）都走这一步。
 *
 * `identity` 允许 `null`（uid 还没解析出来 / guid 读不到）：那时读了物料也
 * 不登记，`registered` 会是 `false`，调用方据此给出「物料不齐」的提示，而不是
 * 发出一包必然被服务端以 `-10003` 拒绝的请求。
 */
export async function attachAndRegisterSsoSession(
  nt: NtHelperBinding,
  platform: Platform,
  attachHook: AttachHook,
  pid: number,
  uin: string,
  identity: { uid?: string | null; guid?: string | null },
): Promise<{ material: SessionMaterial; registered: boolean }> {
  const material = await attachHook.ensure(pid, uin);
  const uid = identity.uid ?? null;
  const guid = identity.guid ?? null;
  if (!uid || !guid) {
    logger.warn('session identity incomplete; native transport not configured', {
      event: 'set-sso-session-skipped',
      pid,
      uin,
      hasUid: Boolean(uid),
      hasGuid: Boolean(guid),
    });
    return { material, registered: false };
  }
  const registered = await registerSsoSession(nt, platform, pid, { uin, uid, guid }, material);
  return { material, registered };
}
