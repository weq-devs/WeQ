import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { macSigningIdentity, verifyMacCertificate } from './verify-macos-signing.mjs';

const run = promisify(execFile);

/** CI 先显式导入并核验证书；打包步骤只接收钥匙串路径，不触发 builder 自动发现。 */
export async function prepareMacSigning(env = process.env) {
  if (process.platform !== 'darwin') throw new Error('正式 macOS 签名须在 macOS runner 上准备');
  if (!env.CSC_LINK || !env.CSC_KEY_PASSWORD || !env.RUNNER_TEMP || !env.GITHUB_ENV)
    throw new Error('正式 macOS 签名缺少 CSC_LINK / CSC_KEY_PASSWORD 或 runner 环境');
  const directory = await mkdtemp(join(env.RUNNER_TEMP, 'weq-release-signing-'));
  const keychain = join(directory, 'signing.keychain-db');
  const p12 = join(directory, 'identity.p12');
  try {
    // CSC_LINK 在本流程中只接受 secret 中的 base64 P12，不下载外部链接。
    if (!/^[A-Za-z0-9+/=\s]+$/.test(env.CSC_LINK)) throw new Error('证书不是 base64 P12');
    await writeFile(p12, Buffer.from(env.CSC_LINK, 'base64'), { mode: 0o600, flag: 'wx' });
    const password = env.CSC_KEY_PASSWORD;
    await run('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    await run('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    await run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
    await run('/usr/bin/security', [
      'import',
      p12,
      '-k',
      keychain,
      '-P',
      password,
      '-T',
      '/usr/bin/codesign',
    ]);
    await run('/usr/bin/security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ]);
    const { stdout } = await run('/usr/bin/security', [
      'find-certificate',
      '-c',
      'WeQ Release Signing',
      '-p',
      keychain,
    ]);
    verifyMacCertificate(stdout);
    await writeFile(env.GITHUB_ENV, `CSC_KEYCHAIN=${keychain}\n`, { flag: 'a' });
    console.log(`固定 macOS 发布证书已准备：${macSigningIdentity.certificateSha256}`);
  } catch {
    await run('/usr/bin/security', ['delete-keychain', keychain]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    // security 的异常参数包含密码，不转发原异常或命令。
    throw new Error('macOS 发布签名准备失败，请检查证书、密码和固定指纹；未退回 ad-hoc');
  } finally {
    await rm(p12, { force: true });
  }
}

export async function cleanupMacSigning(env = process.env) {
  const keychain = env.CSC_KEYCHAIN;
  if (!keychain) return;
  const root = resolve(env.RUNNER_TEMP ?? '');
  const directory = dirname(keychain);
  if (
    !env.RUNNER_TEMP ||
    dirname(directory) !== root ||
    !basename(directory).startsWith('weq-release-signing-') ||
    join(directory, 'signing.keychain-db') !== keychain
  )
    throw new Error('不清理非本轮 CI 签名钥匙串');
  await run('/usr/bin/security', ['delete-keychain', keychain]);
  await rm(directory, { recursive: true, force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === '--cleanup') await cleanupMacSigning();
    else await prepareMacSigning();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
