import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const run = promisify(execFile);
export const MAC_BUNDLE_ID = 'app.weq.desktop';
export const MAC_STAGE_PREFIX = '.weq-update-';

export const macUpdatePlanSchema = z.object({
  target: z.string(),
  staging: z.string(),
  version: z.string(),
  previousVersion: z.string(),
  arch: z.enum(['arm64', 'x64']),
  report: z.string(),
});
export type MacUpdatePlan = z.infer<typeof macUpdatePlanSchema>;
export const macUpdateResultSchema = z.object({
  phase: z.enum(['prepared', 'installing', 'installed', 'error']),
  plan: macUpdatePlanSchema,
  message: z.string().optional(),
});

export async function writeMacUpdateResult(
  plan: MacUpdatePlan,
  phase: z.infer<typeof macUpdateResultSchema>['phase'],
  message?: string,
): Promise<void> {
  const temporary = `${plan.report}.tmp`;
  await writeFile(temporary, JSON.stringify({ phase, plan, message }), { mode: 0o600 });
  await rename(temporary, plan.report);
}

/** ad-hoc 默认 DR 是单个构建的 cdhash，不能作为跨版本的发布者身份。 */
export function isAdhocSignature(details: string): boolean {
  return /^Signature=adhoc\r?$/m.test(details);
}

export function macAppBundle(executable: string): string {
  const bundle = resolve(dirname(executable), '../..');
  if (
    !isAbsolute(executable) ||
    basename(bundle) !== 'weQ.app' ||
    dirname(executable) !== join(bundle, 'Contents', 'MacOS')
  )
    throw new Error('无法识别当前 macOS 应用位置，请将 WeQ 安装到应用程序文件夹后重试。');
  return bundle;
}

const releaseSchema = z.object({
  tag_name: z.string(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(
    z.object({
      name: z.string(),
      state: z.literal('uploaded'),
      digest: z.string().nullable().optional(),
      size: z.number().int().positive(),
    }),
  ),
});

/** 信任锚只来自官方 HTTPS API，不接受加速站同时提供包与自报哈希。 */
export function officialMacArchive(
  data: unknown,
  version: string,
  fileName: string,
): {
  arch: 'arm64' | 'x64';
  sha256: string;
  size: number;
} {
  const release = releaseSchema.parse(data);
  if (release.tag_name !== `v${version}` && release.tag_name !== version)
    throw new Error('官方 Release 版本与更新包不一致');
  const arch =
    fileName === `weQ-${version}-mac-arm64.zip`
      ? 'arm64'
      : fileName === `weQ-${version}-mac-x64.zip`
        ? 'x64'
        : null;
  const asset = release.assets.find((item) => item.name === fileName);
  if (!arch || !asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''))
    throw new Error('官方 Release 缺少此架构更新包的 SHA-256，未安装；请稍后重试或手动下载。');
  return { arch, sha256: asset.digest?.slice(7) ?? '', size: asset.size };
}

export async function verifyMacArchive(path: string, expected: { sha256: string; size: number }) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size !== expected.size)
    throw new Error('更新包大小与官方 Release 不一致');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== expected.sha256)
    throw new Error('更新包与官方 SHA-256 不匹配，未安装');
}

export async function verifyMacBundle(bundle: string, version?: string, arch?: 'arm64' | 'x64') {
  if (!(await lstat(bundle)).isDirectory()) throw new Error('更新应用不是普通目录');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120_000 });
  const plist = join(bundle, 'Contents', 'Info.plist');
  const field = async (key: string) =>
    (await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
  if ((await field('CFBundleIdentifier')) !== MAC_BUNDLE_ID) throw new Error('更新应用标识不匹配');
  if (version && (await field('CFBundleShortVersionString')) !== version)
    throw new Error('更新应用版本不匹配');
  const executable = await field('CFBundleExecutable');
  if (!executable || basename(executable) !== executable) throw new Error('更新应用可执行文件无效');
  if (arch)
    await run('/usr/bin/lipo', [
      '-verify_arch',
      arch === 'x64' ? 'x86_64' : arch,
      join(bundle, 'Contents', 'MacOS', executable),
    ]);
}

export function validateMacUpdatePlan(input: unknown): MacUpdatePlan {
  const plan = macUpdatePlanSchema.parse(input);
  if (
    ![plan.target, plan.staging, plan.report].every(isAbsolute) ||
    basename(plan.target) !== 'weQ.app' ||
    !basename(plan.staging).startsWith(MAC_STAGE_PREFIX) ||
    dirname(plan.staging) !== dirname(plan.target) ||
    resolve(plan.staging) !== plan.staging ||
    resolve(plan.target) !== plan.target
  )
    throw new Error('更新安装路径无效');
  return plan;
}

/** 同卷 rename，不覆盖原目录；任一步失败都尽力恢复旧应用，保留失败现场。 */
export async function replaceMacApp(input: MacUpdatePlan): Promise<void> {
  const plan = validateMacUpdatePlan(input);
  const next = join(plan.staging, 'weQ.app');
  const previous = join(plan.staging, 'previous.app');
  await verifyMacBundle(plan.target, plan.previousVersion);
  await verifyMacBundle(next, plan.version, plan.arch);
  let moved = false;
  let replaced = false;
  try {
    await rename(plan.target, previous);
    moved = true;
    await rename(next, plan.target);
    replaced = true;
    await run('/usr/bin/open', ['-n', plan.target], { timeout: 30_000 });
  } catch (error) {
    if (moved) {
      try {
        if (replaced) await rename(plan.target, join(plan.staging, 'failed.app'));
        await rename(previous, plan.target);
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          `更新失败且自动恢复未完成，旧应用保存在 ${previous}`,
        );
      }
      await run('/usr/bin/open', ['-n', plan.target], { timeout: 30_000 }).catch(() => {});
    }
    throw error;
  }
}
