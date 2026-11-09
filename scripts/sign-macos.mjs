import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { macSigningIdentity, verifyMacReleaseBundle } from './verify-macos-signing.mjs';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { signAsync } = require('@electron/osx-sign');
const run = promisify(execFile);

/** electron-builder 25 不会为无证书构建自动补完整的 ad-hoc 资源签名。 */
export function macSigningOptions(options, env = process.env) {
  if (options.platform !== 'darwin' || options.identity === null)
    throw new Error('仅支持未禁用签名的 macOS 桌面构建');
  const mode = env.WEQ_MAC_SIGNING_MODE;
  if (mode && mode !== 'self-signed' && mode !== 'adhoc') throw new Error('未知 macOS 签名模式');
  if (mode === 'self-signed' && !options.keychain) throw new Error('正式签名缺少专用钥匙串');
  if (!mode && options.identity && options.identity !== '-') return { ...options };
  return {
    ...options,
    identity: mode === 'self-signed' ? macSigningIdentity.certificateSha1 : '-',
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
  if (process.env.WEQ_MAC_SIGNING_MODE === 'self-signed') await verifyMacReleaseBundle(options.app);
}

export default sign;
