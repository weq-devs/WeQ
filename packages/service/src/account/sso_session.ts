/**
 * 借 QQ 凭据发包前的**唯一登记口**：把一次会话的内存物料（a2 / d2 / d2key）
 * 与身份（uin / uid / guid）交给原生侧（`setSsoSession`）。
 *
 * 为什么单独成模块：`sendOidbPacket` / `sendPacket` 只是「组帧 → 直连」，
 * 它们**不带凭据** —— native 侧按 pid 在一张表里找已登记的会话物料，找不到
 * 就报「pid X 还没有登记 SSO 会话」。所以任何「先取物料、再发包」的流程
 * （登录时的 0xcde_2 取密钥、妙妙工具的其它设备密钥、账号 monitor 的
 * rkey/clientkey 采集）都必须在发包前走这里登记一次，否则第一包必然失败。
 *
 * **只登记、不建连**：TCP 等到真要发包时才连；在线状态与心跳交给同机 QQ
 * 本体维持（见 `sso/client.rs` 的模块注释）。
 */

import type { NtHelperBinding, SessionMaterial } from '@weq/native';
import type { Platform } from '@weq/platform';
import type { AttachHook } from '../bootstrap/attach';
import { getLogger } from '../common/logger';

/** PC 端 `subAppId`（抓包实测值，注册包里它也出现）。 */
export const PC_SUB_APP_ID = 537391664;

/** 发包时服务端认的三件身份：账号 uin、账号 uid、设备 guid。 */
export interface SsoIdentity {
  /** 账号 UIN 十进制串。 */
  uin: string;
  /** 账号 uid（`u_...`）；服务端校验不过会回 `-10003 身份验证失败`。 */
  uid: string;
  /** 设备 guid（32 位小写 hex）；服务端认设备的依据。 */
  guid: string;
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
  if (!material.a2 || !material.d2 || !material.d2Key) return null;
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
export async function registerSsoSession(
  nt: Pick<NtHelperBinding, 'setSsoSession'>,
  platform: Pick<Platform, 'qqWrapperNodePath'>,
  pid: number,
  identity: SsoIdentity,
  material: SessionMaterial,
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
    await nt.setSsoSession(
      pid,
      {
        uin: identity.uin,
        a2: buffers.a2,
        d2: buffers.d2,
        d2Key: buffers.d2Key,
        guid: identity.guid,
        uid: identity.uid,
        subAppId: PC_SUB_APP_ID,
      },
      platform.qqWrapperNodePath(),
    );
    logger.info('stored session material for the native sso transport', {
      event: 'set-sso-session',
      pid,
      uin: identity.uin,
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

/**
 * 一次把「读内存拿物料」和「登记 SSO 会话」做完 —— 所有「先 attach 再发包」
 * 的流程（登录取密钥、妙妙工具的其它设备密钥、账号 monitor 采集）都走这一步。
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
