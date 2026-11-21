import type { ServerResponse } from 'node:http';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
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
  source: string | readonly { path: string; name: string }[],
  name: string,
): Promise<void> {
  if (typeof source === 'string' && !(await lstat(source)).isDirectory())
    throw new Error('导出下载目录不存在。');
  const files =
    typeof source === 'string'
      ? entries(source)
      : source.map((file) => ({ ...file, directory: false }));
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
    for await (const entry of files) {
      controller.signal.throwIfAborted();
      if (typeof source !== 'string') {
        if (!(await lstat(entry.path)).isFile()) throw new Error('闪传成品已不可用。');
        const file = await open(
          entry.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          if (!(await file.stat()).isFile()) throw new Error('闪传成品已不可用。');
          controller.signal.throwIfAborted();
          const input = file.createReadStream({ signal: controller.signal });
          input.once('error', (error) => archive.destroy(error));
          const added = once(archive, 'entry', { signal: controller.signal });
          archive.append(input, { name: entry.name });
          await added;
        } finally {
          await file.close();
        }
      } else {
        const added = once(archive, 'entry', { signal: controller.signal });
        if (entry.directory) archive.append(Buffer.alloc(0), { name: `${entry.name}/` });
        else archive.file(entry.path, { name: entry.name });
        await added;
      }
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
