import prepareRemoteNetwork from './package-remote-network.mjs';
import { verifyQqSync } from '../packages/native/qq-sync.mjs';
import { fileURLToPath } from 'node:url';

/** 打包使用已校验的私仓运行产物，公开仓不构建桥接源码。 */
export default function prepareDesktopRuntime(context) {
  if (context.electronPlatformName === 'win32')
    verifyQqSync(fileURLToPath(new URL('../native/qq-sync/', import.meta.url)));
  return prepareRemoteNetwork(context);
}
