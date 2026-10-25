import { cp, link, lstat, open, readdir, unlink, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizeSegment, uniqueName } from '../../common/path_sanitize';
import { createAtomicExportBundle } from './atomic_bundle';
import { fileSha256 } from './resume';
import { assertDestinationCapacity } from './storage_preflight';

export type ExportSaveMode = 'preset' | 'before' | 'after';

export interface ExportSavePolicy {
  mode: ExportSaveMode;
  directory?: string;
  filePath?: string;
  uniqueFileName?: boolean;
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
    return {
      mode,
      filePath: resolve(policy.filePath),
      ...(policy.uniqueFileName ? { uniqueFileName: true } : {}),
    };
  }
  if (policy.uniqueFileName) throw new Error('自动文件命名仅支持单文件位置。');
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

/** 自动命名不会跟随已有同名文件的链接，只解析用户指定的父文件夹。 */
export function resolveExportSaveFile(root: string, selected: string, unique = false): string {
  return unique
    ? join(resolveExportSaveDirectory(root, dirname(selected)), basename(selected))
    : resolveExportSaveDirectory(root, selected);
}

interface SourceOutput {
  name: string;
  filePath?: string;
  bundleDir?: string;
  reportPath?: string;
  reportHtmlPath?: string;
}

function reportFiles(output: SourceOutput): Array<{ path: string; extension: string }> {
  return [
    ...(output.reportPath ? [{ path: output.reportPath, extension: 'json' }] : []),
    ...(output.reportHtmlPath ? [{ path: output.reportHtmlPath, extension: 'html' }] : []),
  ];
}

interface PublishedFile {
  dev: number;
  ino: number;
}
/** 只移除本轮创建且仍是同一文件的目标，不删除后来被替换的文件。 */
async function removeOwnPublication(target: string, original: PublishedFile): Promise<void> {
  const published = await lstat(target).catch(() => null);
  if (published && original.dev === published.dev && original.ino === published.ino)
    await unlink(target);
}

async function supportsFileLinks(directory: string): Promise<boolean> {
  const source = join(directory, 'link-probe'),
    target = join(directory, 'link-probe-target');
  await writeFile(source, '');
  try {
    await link(source, target);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(String(error.code))
    )
      return false;
    throw error;
  } finally {
    await unlink(source);
    await unlink(target).catch(() => {});
  }
}

/** 不支持硬链接的卷使用独占句柄流式写入，已有文件永远不会被打开覆盖。 */
async function publishVerifiedCopy(
  source: string,
  target: string,
  expectedHash: string,
  signal?: AbortSignal,
): Promise<PublishedFile> {
  assertDestinationCapacity(target, source);
  const handle = await open(target, 'wx');
  const input = createReadStream(source);
  let receipt: PublishedFile | undefined;
  let closed = false;
  try {
    receipt = await handle.stat();
    for await (const chunk of input) {
      signal?.throwIfAborted();
      if (!Buffer.isBuffer(chunk)) throw new Error('文件流未返回二进制数据。');
      for (let offset = 0; offset < chunk.length; ) {
        const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
        if (!bytesWritten) throw new Error('文件复制未取得进展。');
        offset += bytesWritten;
      }
    }
    signal?.throwIfAborted();
    const published = await lstat(target);
    if (
      published.dev !== receipt.dev ||
      published.ino !== receipt.ino ||
      (await fileSha256(target, signal)) !== expectedHash ||
      (await fileSha256(source, signal)) !== expectedHash
    )
      throw new Error('文件复制校验失败或保存目标已改变。');
    return receipt;
  } catch (error) {
    input.destroy();
    await handle.close();
    closed = true;
    if (receipt) await removeOwnPublication(target, receipt);
    throw error;
  } finally {
    input.destroy();
    if (!closed) await handle.close();
  }
}

async function saveSingleExportFile(
  output: SourceOutput,
  selected: string,
  signal?: AbortSignal,
  unique = false,
): Promise<string> {
  if (output.bundleDir) throw new Error('结果包含多个文件，请选择保存文件夹。');
  if (!output.filePath) throw new Error('导出结果不存在。');
  if (!isAbsolute(selected)) throw new Error('保存文件必须是绝对路径。');
  const root = resolveThroughExistingParent(dirname(selected));
  const target = join(root, basename(selected));
  if (!(await lstat(root).catch(() => null))?.isDirectory())
    throw new Error('保存目录不可用，请重新选择。');
  const source = realpathSync(output.filePath);
  if (!(await lstat(output.filePath)).isFile()) throw new Error('导出结果不是普通文件。');
  if (source === target) throw new Error('不能将结果保存回导出源文件。');
  const reports = reportFiles(output);
  assertDestinationCapacity(target, [source, ...reports.map((report) => report.path)]);
  const bundle = createAtomicExportBundle(root, `save-${randomUUID()}`);
  const stage = join(bundle.stageDir, 'result');
  try {
    signal?.throwIfAborted();
    const atomic = await supportsFileLinks(bundle.stageDir);
    const hash = await fileSha256(source, signal);
    if (atomic) {
      await cp(source, stage, { force: false, errorOnExist: true });
      if ((await fileSha256(stage, signal)) !== hash) throw new Error('导出文件保存校验失败。');
    }
    const stagedReports: Array<{ path: string; stage: string; extension: string; hash: string }> =
      [];
    for (const report of reports) {
      if (!(await lstat(report.path)).isFile()) throw new Error('完整性报告不是普通文件。');
      const reportHash = await fileSha256(report.path, signal);
      const stageReport = join(bundle.stageDir, `report.${report.extension}`);
      if (atomic) {
        await cp(report.path, stageReport, { force: false, errorOnExist: true });
        if ((await fileSha256(stageReport, signal)) !== reportHash)
          throw new Error('导出报告保存校验失败。');
      }
      stagedReports.push({ ...report, stage: stageReport, hash: reportHash });
    }
    for (const report of stagedReports)
      if ((await fileSha256(report.path, signal)) !== report.hash)
        throw new Error('保存期间导出报告发生变化，未发布目标。');
    if (atomic && (await fileSha256(source, signal)) !== hash)
      throw new Error('保存期间导出源发生变化，未发布目标。');
    const used = new Set<string>();
    for (;;) {
      signal?.throwIfAborted();
      const candidate = unique ? join(root, uniqueName(basename(target), used)) : target;
      const receipts: Array<{ target: string; receipt: PublishedFile }> = [];
      try {
        for (const report of stagedReports) {
          const reportTarget = `${candidate}.report.${report.extension}`;
          if (atomic) {
            await link(report.stage, reportTarget);
            receipts.push({ target: reportTarget, receipt: await lstat(report.stage) });
          } else
            receipts.push({
              target: reportTarget,
              receipt: await publishVerifiedCopy(report.path, reportTarget, report.hash, signal),
            });
        }
        signal?.throwIfAborted();
        if (atomic) await link(stage, candidate);
        else await publishVerifiedCopy(source, candidate, hash, signal);
        return candidate;
      } catch (error) {
        for (const report of receipts) await removeOwnPublication(report.target, report.receipt);
        if (unique && error instanceof Error && 'code' in error && error.code === 'EEXIST')
          continue;
        throw error;
      }
    }
  } catch (error) {
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

/** 校验后才回报成功；目录与支持链接的卷原子发布，其余卷独占复制，均不覆盖原件。 */
export async function saveExportOutput(
  output: SourceOutput,
  directory: string | { filePath: string; unique?: boolean },
  signal?: AbortSignal,
  options?: { requireExistingDirectory?: boolean },
): Promise<string> {
  if (typeof directory !== 'string')
    return saveSingleExportFile(output, directory.filePath, signal, directory.unique);
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
  assertDestinationCapacity(
    join(target, 'result'),
    !output.bundleDir
      ? [sourcePath, ...reportFiles(output).map((report) => report.path)]
      : sourcePath,
  );
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
      for (const report of reportFiles(output)) {
        const reportHash = await fileSha256(report.path, signal);
        const savedReport = join(bundle.stageDir, `export-report.${report.extension}`);
        await cp(report.path, savedReport, { force: false, errorOnExist: true });
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
