/**
 * 从安装的 QQ 读 `major.node` 的 appid / QUA / 版本。
 *
 * 有头模式（mode 1）需要这三个字段拼 SSO 头，且**必须取当前运行的 QQ 版本**：
 * `subAppId` 写错会让服务端静默丢弃 ECDH（TCP 通、只回 ACK、零应用层字节），
 * 看起来像网络问题。`packages/service/src/bootstrap/key.ts` 里有一份同样的
 * 私有实现（登录链路用），这里保持同样的规则：
 *
 *   - 拿不到 `major.node` 就是硬错误，不回退到常量；
 *   - `clientVersion = version + '-' + build`；
 *   - `qua` 原样透传。
 */

import type { NtHelperBinding } from '@weq/native';
import type { Platform } from '@weq/platform';

export interface OneBotAppidInfo {
  subAppId: number;
  qua?: string;
  clientVersion?: string;
  wrapperPath?: string;
}

export function resolveOneBotAppid(
  platform: Pick<Platform, 'qqMajorNodePath' | 'qqWrapperNodePath'>,
  nt: Pick<NtHelperBinding, 'resolveAppidFromMajor'>,
): OneBotAppidInfo | null {
  const majorPath = platform.qqMajorNodePath();
  if (!majorPath) return null;
  let info: { appid: string; qua?: string; version?: string; build?: string };
  try {
    info = nt.resolveAppidFromMajor(majorPath);
  } catch {
    return null;
  }
  const subAppId = Number(info.appid);
  if (!Number.isSafeInteger(subAppId) || subAppId <= 0) return null;
  const clientVersion = info.version && info.build ? `${info.version}-${info.build}` : undefined;
  const wrapperPath = platform.qqWrapperNodePath() ?? undefined;
  return {
    subAppId,
    ...(info.qua ? { qua: info.qua } : {}),
    ...(clientVersion ? { clientVersion } : {}),
    ...(wrapperPath ? { wrapperPath } : {}),
  };
}
