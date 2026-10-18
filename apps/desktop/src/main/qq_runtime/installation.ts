import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Platform } from '@weq/platform';

export interface QQManagedInstallation {
  wrapperPath: string;
  majorPath: string;
  client: { appId: string; version: string; qua: string };
}

type InstallationSource = Pick<
  Platform,
  'kind' | 'qqWrapperNodePath' | 'qqMajorNodePath' | 'qqVersion'
> & {
  native: { ntHelper: Pick<Platform['native']['ntHelper'], 'resolveAppidFromMajor'> };
};

/** 托管启动只用安装版的成对模块，不混入某个外部 QQ 的热更新。 */
export async function discoverManagedQQInstallation(
  source: InstallationSource,
): Promise<QQManagedInstallation> {
  if (source.kind !== 'darwin') throw new Error('QQ 托管目前只支持 macOS');
  const wrapper = source.qqWrapperNodePath(),
    major = source.qqMajorNodePath();
  if (!wrapper || !major) throw new Error('未找到完整的 QQ 安装，请先安装官方 QQ');
  const [wrapperPath, majorPath] = await Promise.all([realpath(wrapper), realpath(major)]);
  if (dirname(wrapperPath) !== dirname(majorPath))
    throw new Error('QQ 内核与客户端信息不属于同一安装');
  const files = await Promise.all([stat(wrapperPath), stat(majorPath)]);
  if (files.some((file) => !file.isFile() || file.size === 0))
    throw new Error('QQ 安装中的原生模块无效');
  const info = source.native.ntHelper.resolveAppidFromMajor(majorPath);
  const version = source.qqVersion();
  if (
    !/^[1-9]\d*$/.test(info.appid) ||
    Number(info.appid) > 0xffffffff ||
    !info.qua ||
    info.qua.length > 4096
  ) {
    throw new Error('无法读取此 QQ 构建的客户端身份，不使用默认版本启动');
  }
  if (!info.version || !info.build || !version || version !== `${info.version}-${info.build}`) {
    throw new Error('QQ 安装版本与原生模块信息不一致，请完成 QQ 更新后重试');
  }
  return { wrapperPath, majorPath, client: { appId: info.appid, version, qua: info.qua } };
}
