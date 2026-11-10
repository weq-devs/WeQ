import { execFile } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

/** 每次显式创建一个新身份；不覆盖已有凭据，不改用户钥匙串搜索列表。 */
export async function createMacSigningIdentity(directory) {
  if (process.platform !== 'darwin') throw new Error('签名身份须在 macOS 上创建');
  await mkdir(directory, { mode: 0o700 });
  const password = randomBytes(32).toString('base64url');
  const env = { ...process.env, WEQ_SIGNING_PASSWORD: password };
  const command = async (file, args) => run(file, args, { env, timeout: 30_000 });
  const certificate = join(directory, 'certificate.pem');
  const privateKey = join(directory, 'private-key.pem');
  const p12 = join(directory, 'identity.p12');
  const keychain = join(directory, 'signing.keychain-db');
  try {
    // 预建 0600 文件，OpenSSL 覆写时保持 mode；不修改进程级 umask。
    await writeFile(privateKey, '', { mode: 0o600, flag: 'wx' });
    await writeFile(p12, '', { mode: 0o600, flag: 'wx' });
    await command('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-sha256',
      '-days',
      '3650',
      '-subj',
      '/CN=WeQ Release Signing/',
      '-addext',
      'basicConstraints=critical,CA:false',
      '-addext',
      'keyUsage=critical,digitalSignature',
      '-addext',
      'extendedKeyUsage=critical,codeSigning',
      '-keyout',
      privateKey,
      '-out',
      certificate,
      '-passout',
      'env:WEQ_SIGNING_PASSWORD',
    ]);
    await command('openssl', [
      'pkcs12',
      '-export',
      '-inkey',
      privateKey,
      '-in',
      certificate,
      '-out',
      p12,
      '-passin',
      'env:WEQ_SIGNING_PASSWORD',
      '-passout',
      'env:WEQ_SIGNING_PASSWORD',
      '-keypbe',
      'PBE-SHA1-3DES',
      '-certpbe',
      'PBE-SHA1-3DES',
      '-macalg',
      'sha1',
    ]);
    await writeFile(join(directory, 'password'), password, { mode: 0o600, flag: 'wx' });
    await command('/usr/bin/security', ['create-keychain', '-p', password, keychain]);
    await command('/usr/bin/security', ['unlock-keychain', '-p', password, keychain]);
    await command('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]);
    await command('/usr/bin/security', [
      'import',
      p12,
      '-k',
      keychain,
      '-P',
      password,
      '-T',
      '/usr/bin/codesign',
    ]);
    await command('/usr/bin/security', [
      'set-key-partition-list',
      '-S',
      'apple-tool:,apple:,codesign:',
      '-s',
      '-k',
      password,
      keychain,
    ]);
    const cert = new X509Certificate(await readFile(certificate));
    return {
      directory,
      certificateSha1: cert.fingerprint.replaceAll(':', '').toLowerCase(),
      certificateSha256: cert.fingerprint256.replaceAll(':', '').toLowerCase(),
    };
  } catch {
    // 不输出子进程异常对象，其中的 security 参数可能含密码。
    throw new Error(`签名身份创建未完成，保留现场：${directory}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = resolve(
    process.argv[2] ?? join(homedir(), 'Library/Application Support/WeQSigning/release'),
  );
  try {
    await mkdir(join(directory, '..'), { recursive: true, mode: 0o700 });
    console.log(JSON.stringify(await createMacSigningIdentity(directory)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
