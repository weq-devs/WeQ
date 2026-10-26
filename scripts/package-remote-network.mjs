import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { accessSync, constants, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareRemoteNetwork } from './prepare-remote-network.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { Arch } = require('electron-builder');
const platformKeys = { darwin: 'mac', win32: 'win', linux: 'linux' };
export const MIN_REMOTE_GO_VERSION = '1.27.3';

export function remoteNetworkTarget(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const key = platformKeys[platform];
  if (!key || !['x64', 'arm64'].includes(arch))
    throw new Error(`不支持 Remote 辅助程序目标：${platform}/${arch}`);
  return { platform, arch, directory: join(root, 'tools/remote-network/build', key, arch) };
}

/** 每个目标独立构建目录，多个平台/架构打包不争用同一二进制。 */
export default function preparePackagedRemoteNetwork(context) {
  const target = remoteNetworkTarget(context);
  const helper = prepareRemoteNetwork({
    platform: target.platform,
    arch: target.arch,
    outputDirectory: target.directory,
  });
  verifyRemoteNetworkBinary(helper, target.platform, target.arch);
}

export function verifyRemoteNetworkBinary(helper, platform, arch, inspect = execFileSync) {
  const stat = lstatSync(helper);
  if (!stat.isFile() || stat.size === 0) throw new Error('Remote 辅助程序缺失或为空');
  if (platform !== 'win32') accessSync(helper, constants.X_OK);
  const info = JSON.parse(
    inspect('go', ['version', '-m', '-json', helper], { encoding: 'utf8', windowsHide: true }),
  );
  const goVersion = /^go(\d+)\.(\d+)\.(\d+)$/.exec(info.GoVersion ?? '');
  const minimum = MIN_REMOTE_GO_VERSION.split('.').map(Number);
  const version = goVersion?.slice(1).map(Number);
  const comparison = version
    ? version[0] - minimum[0] || version[1] - minimum[1] || version[2] - minimum[2]
    : -1;
  if (comparison < 0)
    throw new Error(`Remote 辅助程序必须由 Go ${MIN_REMOTE_GO_VERSION} 或更高稳定版构建`);
  const settings = new Map((info.Settings ?? []).map(({ Key, Value }) => [Key, Value]));
  if (
    info.Path !== 'weq.local/remote-network' ||
    settings.get('GOOS') !== (platform === 'win32' ? 'windows' : platform) ||
    settings.get('GOARCH') !== (arch === 'x64' ? 'amd64' : arch)
  )
    throw new Error(`Remote 辅助程序目标架构不符：${platform}/${arch}`);
}

export function verifyPackagedRemoteNetwork(context, resources) {
  const { platform, arch } = remoteNetworkTarget(context);
  verifyRemoteNetworkBinary(
    join(
      resources,
      'remote-network',
      platform === 'win32' ? 'weq-remote-network.exe' : 'weq-remote-network',
    ),
    platform,
    arch,
  );
}
