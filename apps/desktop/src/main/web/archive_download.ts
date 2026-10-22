import type { ServerResponse } from 'node:http';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';

async function* entries(
  root: string,
  directory = root,
): AsyncGenerator<{ path: string; name: string; directory: boolean }> {
  for (const child of (await readdir(directory)).sort()) {
    const path = join(directory, child);
    const info = await lstat(path);
    if (!info.isFile() && !info.isDirectory()) throw new Error('导出下载包含非普通文件。');
    const name = relative(root, path).split(sep).join('/');
    yield { path, name, directory: info.isDirectory() };
    if (info.isDirectory()) yield* entries(root, path);
  }
}

/** 两种 Web 入口共用 ZIP 流，不额外复制媒体目录；断开只中止本次传输。 */
export async function streamArchiveDownload(
  res: ServerResponse,
  path: string,
  name: string,
): Promise<void> {
  if (!(await lstat(path)).isDirectory()) throw new Error('导出下载目录不存在。');
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableFinished) controller.abort();
  };
  res.on('close', onClose);
  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.on('warning', (error) => archive.destroy(error));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'no-store');
  const pumped = pipeline(archive, res, { signal: controller.signal }).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    for await (const entry of entries(path)) {
      controller.signal.throwIfAborted();
      const added = once(archive, 'entry', { signal: controller.signal });
      if (entry.directory) archive.append(Buffer.alloc(0), { name: `${entry.name}/` });
      else archive.file(entry.path, { name: entry.name });
      await added;
    }
    await archive.finalize();
    const error = await pumped;
    if (error) throw error;
  } catch (error) {
    // 先断开响应，不能让 abort() 的正常结束把不完整 ZIP 作为 200 返回。
    res.destroy();
    archive.abort();
    archive.destroy(error instanceof Error ? error : new Error(String(error)));
    await pumped;
  } finally {
    res.off('close', onClose);
  }
}
