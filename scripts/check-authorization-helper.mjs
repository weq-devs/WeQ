import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  authorizationArtifact,
  authorizationExecutable,
  validateAuthorizationBuildInfo,
  validateNativeBuildInfo,
} from '../packages/native/authorization.mjs';

/** 此入口仅查询二进制构建信息，不安装服务、不读取身份或 QQ。 */
export function verifyAuthorizationHelper(file, platform, options = {}) {
  const stat = lstatSync(file);
  if (!stat.isFile() || (process.platform !== 'win32' && !(stat.mode & 0o111)))
    throw new Error('权限助手缺失、不是普通文件或没有执行权限');
  if (`${process.platform}-${process.arch}` !== platform)
    throw new Error('权限助手发布检查必须在匹配目标的宿主上运行');
  const info = JSON.parse(
    execFileSync(file, ['build-info'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 16384,
      windowsHide: true,
    }),
  );
  validateAuthorizationBuildInfo(info, platform, options);
  return info;
}

export function packagedAuthorizationPath(appDirectory, platform) {
  const [os, arch] = platform.split('-');
  const root = os === 'darwin' ? join(appDirectory, 'Contents', 'Resources') : appDirectory;
  return join(root, 'native', os, arch, authorizationExecutable(platform));
}

export function installedNativeManifest() {
  const file =
    process.env.WEQ_NATIVE_MANIFEST ?? new URL('../native/.installed.json', import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 签名前可比对内容；签名后仅核对不会被签名改写的构建契约。 */
export function verifyPackagedAuthorization(
  appDirectory,
  platform,
  { required = false, manifest, beforeSigning = false } = {},
) {
  if (!required) return;
  const entry = authorizationArtifact(manifest, platform, `native/${platform.replace('-', '/')}`, {
    required: true,
  });
  const file = packagedAuthorizationPath(appDirectory, platform);
  if (beforeSigning) {
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error('打包后的权限助手不是普通文件');
    const { size } = stat;
    if (size !== entry.size) throw new Error('打包后的权限助手体积与原始资产不一致');
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== entry.sha256)
      throw new Error('打包后的权限助手内容与原始资产不一致');
  }
  const info = verifyAuthorizationHelper(file, platform, {
    production: true,
    expected: manifest.authorization[platform],
  });
  const addon = createRequire(import.meta.url)(join(dirname(file), 'nt_helper.node'));
  const addonInfo = addon.getBuildInfo();
  validateNativeBuildInfo(addonInfo, { production: true, expected: info });
  return info;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [appDirectory, platform, manifestFile] = process.argv.slice(2);
    if (!appDirectory || !platform || !manifestFile)
      throw new Error('用法：check-authorization-helper <app-directory> <platform> <manifest>');
    verifyPackagedAuthorization(resolve(appDirectory), platform, {
      required: true,
      manifest: JSON.parse(readFileSync(manifestFile, 'utf8')),
    });
    console.log('打包权限助手构建契约验证通过，未安装服务或访问 QQ');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
