import type { Platform } from '@weq/platform';
import type { AttachHook } from '../bootstrap/attach';
import type { AccountConfig } from './user_config';
import {
  attachAndRegisterSsoSession,
  registerSsoSessionFromStored,
  resolveDeviceGuid,
} from './sso_session';
import { requestDecryptKeyFromInstance } from './online_ticket';

export interface OtherDeviceInstance {
  pid: number;
  uin: string;
  uid: string;
}
export interface OtherDeviceKeyContext {
  attachAttempts: Set<number>;
  registered: Map<number, string>;
}
export const createOtherDeviceKeyContext = (): OtherDeviceKeyContext => ({
  attachAttempts: new Set(),
  registered: new Map(),
});

/** 维护工具与本地备份共用：优先已有会话，再按需读取在线同账号的会话物料。 */
export async function fetchOtherDeviceDatabaseKey(
  platform: Platform,
  configs: AccountConfig[],
  attachHook: AttachHook | undefined,
  dbPath: string,
  options: {
    enabled: boolean;
    expectedUin?: string;
    resolveOnline: () => Promise<OtherDeviceInstance[]>;
    context?: OtherDeviceKeyContext;
  },
): Promise<
  { success: true; key: string; pid: number; uin: string } | { success: false; error: string }
> {
  if (!options.enabled)
    return { success: false, error: '完全离线模式已开启，未请求其他设备密钥。' };
  const context = options.context ?? createOtherDeviceKeyContext();
  let instances: OtherDeviceInstance[];
  try {
    instances = (await options.resolveOnline()).filter(
      (item) => !options.expectedUin || item.uin === options.expectedUin,
    );
  } catch (cause) {
    return {
      success: false,
      error: `无法探测在线 QQ：${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  if (!instances.length)
    return { success: false, error: '未找到同账号在线 QQ，无法获取其他设备密钥。' };
  const nt = platform.native.ntHelper;
  let error = '没有可用的同账号会话物料。';
  const seen = new Set<number>();
  for (const instance of instances) {
    if (seen.has(instance.pid)) continue;
    seen.add(instance.pid);
    const sameAccount = configs.filter((record) => record.uin === instance.uin);
    const uid = instance.uid || sameAccount.find((record) => record.uid)?.uid;
    try {
      const guid =
        resolveDeviceGuid(nt, platform) || sameAccount.find((record) => record.guid)?.guid;
      let registered = context.registered.get(instance.pid) === instance.uin;
      for (const record of sameAccount) {
        if (registered) break;
        registered = await registerSsoSessionFromStored(nt, platform, instance.pid, instance.uin, {
          material: record.session,
          pid: record.qqPid,
          uid,
          guid,
        });
      }
      if (!registered && attachHook && uid && guid && !context.attachAttempts.has(instance.pid)) {
        context.attachAttempts.add(instance.pid);
        registered = (
          await attachAndRegisterSsoSession(nt, platform, attachHook, instance.pid, instance.uin, {
            uid,
            guid,
          })
        ).registered;
      }
      if (!registered) {
        error =
          '同账号会话身份或物料不足（需要 uid、设备 guid 和登录会话），可登录 QQ 后重试或手动输入密钥。';
        continue;
      }
      context.registered.set(instance.pid, instance.uin);
      let key: string;
      try {
        key = await requestDecryptKeyFromInstance(nt, instance.pid, dbPath);
      } catch (cause) {
        // 仅 SSO 层拒绝才刷新可能过期的票据；账号不匹配等 OIDB 业务错误不触发提权。
        if (
          !(cause instanceof Error) ||
          !cause.message.startsWith('SSO error ') ||
          !attachHook ||
          !uid ||
          !guid ||
          context.attachAttempts.has(instance.pid)
        )
          throw cause;
        context.registered.delete(instance.pid);
        context.attachAttempts.add(instance.pid);
        attachHook.reset(instance.pid);
        const refreshed = await attachAndRegisterSsoSession(
          nt,
          platform,
          attachHook,
          instance.pid,
          instance.uin,
          { uid, guid },
        );
        if (!refreshed.registered) throw new Error('刷新同账号会话后仍无法登记身份');
        context.registered.set(instance.pid, instance.uin);
        key = await requestDecryptKeyFromInstance(nt, instance.pid, dbPath);
      }
      return { success: true, key, pid: instance.pid, uin: instance.uin };
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  return { success: false, error };
}
