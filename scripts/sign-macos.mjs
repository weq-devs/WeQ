import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { signAsync } = require('@electron/osx-sign');
const run = promisify(execFile);

/** electron-builder 25 不会为无证书构建自动补完整的 ad-hoc 资源签名。 */
export function macSigningOptions(options) {
  if (options.platform !== 'darwin' || options.identity === null)
    throw new Error('仅支持未禁用签名的 macOS 桌面构建');
  if (options.identity && options.identity !== '-') return { ...options };
  return {
    ...options,
    identity: '-',
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: (file) => ({
      ...options.optionsForFile?.(file),
      timestamp: 'none',
    }),
  };
}

/** 只签构建产物；验证失败直接中止打包，不修改隔离属性或系统安全策略。 */
export async function sign(options) {
  await signAsync(macSigningOptions(options));
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.app]);
}

export default sign;
