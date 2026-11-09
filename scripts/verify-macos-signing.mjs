import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const macSigningIdentity = JSON.parse(
  await readFile(new URL('../apps/desktop/src/shared/mac-signing.json', import.meta.url), 'utf8'),
);
export const macSigningRequirement = `identifier "${macSigningIdentity.bundleId}" and certificate leaf = H"${macSigningIdentity.certificateSha1}"`;

export function verifyMacCertificate(bytes) {
  const certificate = new X509Certificate(bytes);
  if (
    certificate.fingerprint.replaceAll(':', '').toLowerCase() !==
      macSigningIdentity.certificateSha1 ||
    certificate.fingerprint256.replaceAll(':', '').toLowerCase() !==
      macSigningIdentity.certificateSha256
  )
    throw new Error('macOS 发布证书指纹不匹配');
}

export function verifyMacDesignatedRequirement(details) {
  const requirement = /^\s*(?:#\s*)?designated => (.+)$/m.exec(details)?.[1]?.trim();
  if (requirement !== macSigningRequirement) throw new Error('macOS 发布签名未使用固定证书 DR');
}

/** 不信任自报的 Authority 名称：验证实际证书、DR、完整资源及应用标识。 */
export async function verifyMacReleaseBundle(bundle) {
  await run(
    '/usr/bin/codesign',
    ['--verify', '--deep', '--strict', '-R', `=${macSigningRequirement}`, bundle],
    { timeout: 120_000 },
  );
  const { stdout, stderr } = await run('/usr/bin/codesign', ['-d', '-r-', bundle]);
  verifyMacDesignatedRequirement(stdout + stderr);
  const { stdout: identifier } = await run('/usr/bin/plutil', [
    '-extract',
    'CFBundleIdentifier',
    'raw',
    '-o',
    '-',
    join(bundle, 'Contents/Info.plist'),
  ]);
  if (identifier.trim() !== macSigningIdentity.bundleId)
    throw new Error('macOS 发布应用标识不匹配');
  const temporary = await mkdtemp(join(tmpdir(), 'weq-certificate-check-'));
  try {
    const prefix = join(temporary, 'certificate');
    await run('/usr/bin/codesign', ['-d', `--extract-certificates=${prefix}`, bundle]);
    verifyMacCertificate(await readFile(`${prefix}0`));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function verifyMacReleaseArchive(archive) {
  const temporary = await mkdtemp(join(tmpdir(), 'weq-signed-archive-'));
  try {
    await run('/usr/bin/ditto', ['-x', '-k', archive, temporary], { timeout: 120_000 });
    await verifyMacReleaseBundle(join(temporary, 'weQ.app'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const archive = process.argv[2];
    if (!archive?.endsWith('.zip')) throw new Error('用法：verify-macos-signing <发布 ZIP>');
    await verifyMacReleaseArchive(resolve(archive));
    console.log('macOS ZIP 固定证书与完整签名检查通过');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
