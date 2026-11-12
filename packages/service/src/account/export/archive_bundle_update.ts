import assert from 'node:assert/strict';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { readArchiveHeader, scanArchiveFile, streamArchiveEvents } from './archive_stream';
import { archiveResource, fileDigest, publishArchiveResourceFile } from './archive_resource';
import { updateArchiveFile } from './archive_update';
import { stableId, type ArchiveHeader } from './archive';

export interface DomainArchiveTarget {
  directory: string;
  primaryRelative: string;
  primaryPath: string;
  bundle: boolean;
}

/** 仅合并本轮正式归档及其资源；旧目录中的非归档文件不被覆盖或重新打包。 */
export async function updateArchiveBundle(
  stage: string,
  target: DomainArchiveTarget,
  archiveId: string,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  assert((await lstat(target.directory)).isDirectory(), '归档目录不可用，请恢复原位置后继续。');
  const files: Array<{
    source: string;
    path: string;
    archiveId: string;
    format: 'json' | 'jsonl' | 'jsonl.gz';
  }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal.throwIfAborted();
      const source = join(directory, entry.name);
      if (entry.isDirectory() && directory === stage && entry.name === 'albums')
        await visit(source);
      else if (entry.isFile() && /\.(?:json|jsonl(?:\.gz)?)$/.test(entry.name)) {
        const format = entry.name.endsWith('.jsonl.gz')
          ? 'jsonl.gz'
          : entry.name.endsWith('.jsonl')
            ? 'jsonl'
            : 'json';
        let header: ArchiveHeader;
        try {
          header = await readArchiveHeader(source, format);
        } catch {
          continue;
        }
        const path = relative(stage, source);
        const expected =
          directory === stage ? archiveId : stableId('archive-part', [archiveId, 'albums']);
        assert(header.archiveId === expected, '本轮归档身份不匹配');
        files.push({ source, path, archiveId: expected, format });
      }
    }
  };
  await visit(stage);
  assert(
    files.some((file) => file.path === target.primaryRelative),
    '本轮缺少所选正式归档',
  );
  const published = new Map<string, string>();
  for (const file of files) {
    signal.throwIfAborted();
    const path =
      file.path === target.primaryRelative ? target.primaryPath : join(target.directory, file.path);
    const sourceRoot = dirname(file.path) === 'albums' ? stage : dirname(file.source);
    const resourceRoot = dirname(file.path) === 'albums' ? target.directory : dirname(path);
    const info = await lstat(path).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    });
    assert(
      info || file.path !== target.primaryRelative,
      '原正式归档已不存在，请恢复原文件后继续。',
    );
    if (info) {
      assert(info.isFile() && !info.isSymbolicLink(), '正式归档不是普通文件');
      const header = await readArchiveHeader(path, file.format);
      assert(header.archiveId === file.archiveId, '目标已有其他归档，未覆盖');
      await updateArchiveFile(path, file.source, file.format, signal, {
        target: resourceRoot,
        incoming: sourceRoot,
      });
    } else {
      const scan = await scanArchiveFile(file.source, file.format, signal);
      assert(!scan.state.uncommittedTail, '本轮归档尚未完成提交');
      await mkdir(dirname(path), { recursive: true });
      for await (const event of streamArchiveEvents(
        file.source,
        file.format,
        { ...scan.state },
        signal,
      ))
        if (event.type === 'resource' && event.value.status === 'saved')
          await archiveResource(resourceRoot, String(event.value.path), event.value, sourceRoot);
      await publishArchiveResourceFile(file.source, path, await fileDigest(file.source));
    }
    published.set(file.path, path);
  }
  return published;
}
