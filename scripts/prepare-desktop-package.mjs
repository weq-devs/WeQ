import prepareRemoteNetwork from './package-remote-network.mjs';
import { prepareEnhancementEngines } from './prepare-enhancement-engines.mjs';
import { assertNoNativeBinary, buildWeqbotDaemon } from './build-weqbot-daemon.mjs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { Arch } = require('electron-builder');
let daemonBundle;

export default async function prepareDesktopPackage(context) {
  // 同一打包进程的各架构共用纯 JS 产物，且须在复制额外资源前生成。
  daemonBundle ??= buildWeqbotDaemon().then(({ outfile }) => assertNoNativeBinary(outfile));
  await daemonBundle;
  prepareRemoteNetwork(context);
  await prepareEnhancementEngines({
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
  });
}
