import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { macSigningIdentity, verifyMacCertificate } from './verify-macos-signing.mjs';

const run = promisify(execFile);

const SEARCH_LIST_FILE = 'user-search-list.json';

/** `security list-keychains` 每行一个带引号的路径；去掉引号后按顺序还原。 */
export function parseKeychainSearchList(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter((line) => line.length > 0);
}

async function userKeychainSearchList() {
  const { stdout } = await run('/usr/bin/security', ['list-keychains', '-d', 'user']);
  return parseKeychainSearchList(stdout);
}

/**
 * codesign 通过**用户搜索列表**查找身份，`--keychain` 单独给路径并不可靠：
 * 钥匙串里证书、私钥、partition list 全齐也照样报
 * `The specified item could not be found in the keychain`。2.5.3 的 macOS 发布
 * 就卡在这里（x64 / arm64 两份都挂在第一个 codesign 上）。所以导入后把专用
 * 钥匙串追加到搜索列表，并把原始列表存进目录，等着 cleanup 还原。
 */
async function attachKeychainToSearchList(directory, keychain) {
  const original = await userKeychainSearchList();
  await writeFile(join(directory, SEARCH_LIST_FILE), `${JSON.stringify(original)}\n`, {
    mode: 0o600,
  });
  if (!original.includes(keychain))
    await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...original, keychain]);
  return original;
}

async function restoreUserSearchList(directory) {
  const file = join(directory, SEARCH_LIST_FILE);
  if (!existsSync(file)) return;
  const original = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(original) || original.length === 0) return;
  await run('/usr/bin/security', ['list-keychains', '-d', 'user', '-s', ...original]);
}

/** 可以安全写进日志的失败原因（不含 security 参数与密码）。 */
class SafeSigningError extends Error {}

/** 真签一个空文件，让「身份不可用」在这里就失败，而不是打包到一半。 */
async function probeSigning(directory, keychain) {
  const probe = join(directory, 'signing-probe');
  await writeFile(probe, 'weq signing probe\n', { mode: 0o600 });
  try {
    await run('/usr/bin/codesign', [
      '--sign',
      macSigningIdentity.certificateSha1,
      '--keychain',
      keychain,
      '--force',
      probe,
    ]);
    await run('/usr/bin/codesign', ['--verify', probe]);
  } catch (error) {
    // codesign 的 stderr 只有身份/文件信息，可以安全回显。
    const detail = `${error.stderr ?? ''}`.trim().split('\n')[0];
    throw new SafeSigningError(`固定证书在当前钥匙串不可用于签名${detail ? `（${detail}）` : ''}`);
  }
}

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
    await attachKeychainToSearchList(directory, keychain);
    await probeSigning(directory, keychain);
    await writeFile(env.GITHUB_ENV, `CSC_KEYCHAIN=${keychain}\n`, { flag: 'a' });
    console.log(`固定 macOS 发布证书已准备：${macSigningIdentity.certificateSha256}`);
  } catch (error) {
    await restoreUserSearchList(directory).catch(() => {});
    await run('/usr/bin/security', ['delete-keychain', keychain]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
    // security 的异常参数包含密码，只回显自己包装过的安全原因。
    const reason = error instanceof SafeSigningError ? error.message : '请检查证书、密码和固定指纹';
    throw new Error(`macOS 发布签名准备失败，${reason}；未退回 ad-hoc`);
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
  await restoreUserSearchList(directory);
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
