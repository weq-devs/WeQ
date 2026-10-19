import { cp, link, lstat, readdir, unlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeSegment } from '../../common/path_sanitize';
import { createAtomicExportBundle } from './atomic_bundle';
import { fileSha256 } from './resume';
import { assertDestinationCapacity } from './storage_preflight';

export type ExportSaveMode = 'preset' | 'before' | 'after';

export interface ExportSavePolicy {
  mode: ExportSaveMode;
  directory?: string;
  filePath?: string;
}

export interface ExportSaveState {
  policy: ExportSavePolicy;
  status: 'pending' | 'saving' | 'saved' | 'failed' | 'interrupted';
  path?: string;
  error?: string;
}

export function normalizeExportSaveMode(value: unknown): ExportSaveMode {
  return value === 'preset' || value === 'before' ? value : 'after';
}

export function copyExportSavePolicy(policy: ExportSavePolicy): ExportSavePolicy {
  const mode = normalizeExportSaveMode(policy.mode);
  if (mode === 'after') return { mode };
  if (policy.filePath) {
    if (policy.directory) throw new Error('保存位置只能选择文件或目录之一。');
    if (!isAbsolute(policy.filePath)) throw new Error('保存文件必须是绝对路径。');
    return { mode, filePath: resolve(policy.filePath) };
  }
  if (!policy.directory || !isAbsolute(policy.directory))
    throw new Error('开始导出前需要确定有效的绝对保存目录。');
  return { mode, directory: resolve(policy.directory) };
}

function resolveThroughExistingParent(path: string): string {
  const target = resolve(path);
  let parent = target;
  while (!existsSync(parent)) parent = resolve(parent, '..');
  return resolve(realpathSync(parent), relative(parent, target));
}

/** Web 只接受已配置导出根内的位置，包括尚不存在的子目录。 */
export function resolveExportSaveDirectory(root: string, selected = ''): string {
  const base = realpathSync(root);
  const target = resolve(root, selected);
  const isInside = (path: string) => {
    const sub = relative(base, path);
    return sub === '' || (!sub.startsWith(`..${sep}`) && sub !== '..' && !isAbsolute(sub));
  };
  const resolved = resolveThroughExistingParent(target);
  if (!isInside(resolved))
    throw new Error('Web 保存位置必须在服务器配置的导出目录内，不能通过链接指向外部。');
  return resolved;
}

interface SourceOutput {
  name: string;
  filePath?: string;
  bundleDir?: string;
  reportPath?: string;
}

/** 只移除本轮发布且仍指向私有副本的硬链接，不删除后来被替换的文件。 */
async function removeOwnLink(stage: string, target: string): Promise<void> {
  const [original, published] = await Promise.all([lstat(stage), lstat(target).catch(() => null)]);
  if (published && original.dev === published.dev && original.ino === published.ino)
    await unlink(target);
}

async function saveSingleExportFile(
  output: SourceOutput,
  selected: string,
  signal?: AbortSignal,
): Promise<string> {
  if (output.bundleDir) throw new Error('结果包含多个文件，请选择保存文件夹。');
  if (!output.filePath) throw new Error('导出结果不存在。');
  if (!isAbsolute(selected)) throw new Error('保存文件必须是绝对路径。');
  const target = resolveThroughExistingParent(selected);
  const root = dirname(target);
  if (!(await lstat(root).catch(() => null))?.isDirectory())
    throw new Error('保存目录不可用，请重新选择。');
  const source = realpathSync(output.filePath);
  if (!(await lstat(output.filePath)).isFile()) throw new Error('导出结果不是普通文件。');
  if (source === target) throw new Error('不能将结果保存回导出源文件。');
  assertDestinationCapacity(target, source);
  const bundle = createAtomicExportBundle(root, `save-${randomUUID()}`);
  const stage = join(bundle.stageDir, 'result');
  const stageReport = join(bundle.stageDir, 'report');
  const reportTarget = `${target}.report.json`;
  let reportPublished = false;
  let published = false;
  try {
    signal?.throwIfAborted();
    const hash = await fileSha256(source, signal);
    await cp(source, stage, { force: false, errorOnExist: true });
    if ((await fileSha256(stage, signal)) !== hash) throw new Error('导出文件保存校验失败。');
    let reportHash: string | undefined;
    if (output.reportPath) {
      if (!(await lstat(output.reportPath)).isFile()) throw new Error('完整性报告不是普通文件。');
      reportHash = await fileSha256(output.reportPath, signal);
      await cp(output.reportPath, stageReport, { force: false, errorOnExist: true });
      if ((await fileSha256(stageReport, signal)) !== reportHash)
        throw new Error('导出报告保存校验失败。');
    }
    if (
      (await fileSha256(source, signal)) !== hash ||
      (output.reportPath && (await fileSha256(output.reportPath, signal)) !== reportHash)
    )
      throw new Error('保存期间导出源发生变化，未发布目标。');
    signal?.throwIfAborted();
    if (output.reportPath) {
      await link(stageReport, reportTarget);
      reportPublished = true;
    }
    signal?.throwIfAborted();
    await link(stage, target);
    published = true;
    return target;
  } catch (error) {
    if (published) await removeOwnLink(stage, target);
    if (reportPublished) await removeOwnLink(stageReport, reportTarget);
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
      throw new Error('保存位置已有同名文件或报告，请选择其他名称。');
    throw error;
  } finally {
    try {
      bundle.discard();
    } catch {
      console.warn('[export-save] 临时副本清理失败');
    }
  }
}

export async function inventoryExportOutput(
  root: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  async function visit(path: string): Promise<void> {
    signal?.throwIfAborted();
    const info = await lstat(path);
    if (info.isDirectory()) {
      entries.set(relative(root, path), 'directory');
      const children = await readdir(path);
      for (const name of children.sort()) await visit(join(path, name));
    } else if (info.isFile()) {
      entries.set(relative(root, path), `${info.size}:${await fileSha256(path, signal)}`);
    } else {
      throw new Error('导出结果包含非普通文件，未保存或覆盖目标。');
    }
  }
  await visit(root);
  return entries;
}

/** 只发布已完成且逐文件校验的结果；新建独立目录，不合并或覆盖已有同名内容。 */
export async function saveExportOutput(
  output: SourceOutput,
  directory: string | { filePath: string },
  signal?: AbortSignal,
  options?: { requireExistingDirectory?: boolean },
): Promise<string> {
  if (typeof directory !== 'string')
    return saveSingleExportFile(output, directory.filePath, signal);
  if (!isAbsolute(directory)) throw new Error('保存目录必须是绝对路径。');
  const target = resolveThroughExistingParent(directory);
  const source = output.bundleDir || output.filePath;
  if (!source) throw new Error('导出结果不存在。');
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isDirectory() && !sourceInfo.isFile())
    throw new Error('导出结果不是普通文件或目录。');
  const sourcePath = realpathSync(source);
  const inside = relative(sourcePath, target);
  if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside)))
    throw new Error('保存目录不能位于导出源目录内部。');
  if (options?.requireExistingDirectory && !(await lstat(target).catch(() => null))?.isDirectory())
    throw new Error('保存目录不可用，请重新选择。');
  assertDestinationCapacity(join(target, 'result'), sourcePath);
  const bundle = createAtomicExportBundle(
    target,
    `${sanitizeSegment(output.name, 'export')}-${randomUUID()}`,
  );
  try {
    signal?.throwIfAborted();
    const sourceInventory = await inventoryExportOutput(sourcePath, signal);
    if (output.bundleDir) {
      for (const name of await readdir(sourcePath)) {
        signal?.throwIfAborted();
        await cp(join(sourcePath, name), join(bundle.stageDir, name), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
    } else {
      const name = `${sanitizeSegment(output.name, 'export')}${extname(sourcePath)}`;
      await cp(sourcePath, join(bundle.stageDir, name), { force: false, errorOnExist: true });
      if (output.reportPath) {
        const reportHash = await fileSha256(output.reportPath, signal);
        const savedReport = join(bundle.stageDir, 'export-report.json');
        await cp(output.reportPath, savedReport, { force: false, errorOnExist: true });
        if ((await fileSha256(savedReport, signal)) !== reportHash)
          throw new Error('导出报告保存校验失败。');
      }
    }
    signal?.throwIfAborted();
    if (output.bundleDir) {
      const copied = await inventoryExportOutput(bundle.stageDir, signal);
      if (
        sourceInventory.size !== copied.size ||
        [...sourceInventory].some(([path, hash]) => copied.get(path) !== hash)
      )
        throw new Error('导出结果保存校验失败，未发布目标。');
    } else {
      const name = `${sanitizeSegment(output.name, 'export')}${extname(sourcePath)}`;
      const info = await lstat(join(bundle.stageDir, name));
      if (
        `${info.size}:${await fileSha256(join(bundle.stageDir, name), signal)}` !==
        sourceInventory.get('')
      )
        throw new Error('导出文件保存校验失败，未发布目标。');
    }
    const after = await inventoryExportOutput(sourcePath, signal);
    if (
      sourceInventory.size !== after.size ||
      [...sourceInventory].some(([path, hash]) => after.get(path) !== hash)
    )
      throw new Error('保存期间导出源发生变化，未发布目标。');
    bundle.publish();
    return bundle.finalDir;
  } catch (error) {
    bundle.discard();
    throw error;
  }
}
