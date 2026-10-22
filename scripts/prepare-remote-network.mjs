import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 仅编译本机辅助程序，不启动节点、不读取运行身份或修改用户配置。 */
export function prepareRemoteNetwork({
  repoDir = root,
  platform = process.platform,
  arch = process.arch,
  build = spawnSync,
} = {}) {
  const goos = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const goarch = { arm64: 'arm64', x64: 'amd64' }[arch];
  if (!goos || !goarch) throw new Error(`远程网络辅助程序暂不支持 ${platform}/${arch}。`);
  const directory = join(repoDir, 'tools/remote-network');
  const helper = join(
    directory,
    platform === 'win32' ? 'weq-remote-network.exe' : 'weq-remote-network',
  );
  const result = build('go', ['build', '-p', '2', '-trimpath', '-o', helper, '.'], {
    cwd: directory,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch },
  });
  if (result.error)
    throw new Error('无法运行 Go，请先安装或修复 Go 工具链。', { cause: result.error });
  if (result.status !== 0) throw new Error('远程网络辅助程序构建失败，未启动 WeQ。');
  return helper;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log('正在准备远程网络辅助程序（只编译，不启动网络节点）。');
    console.log(`辅助程序已就绪：${prepareRemoteNetwork()}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
