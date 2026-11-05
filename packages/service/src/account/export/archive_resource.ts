import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { JsonObject } from './archive';
import { fileSha256 } from './resume';
import { publishVerifiedCopy } from './save_output';

export async function syncArchiveDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error) {
    if (
      !['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error;
  } finally {
    await directory?.close();
  }
}

export async function fileDigest(path: string): Promise<{ sha256: string; size: string }> {
  const sha256 = await fileSha256(path);
  return { sha256, size: String((await lstat(path, { bigint: true })).size) };
}

export async function publishArchiveResourceFile(
  source: string,
  target: string,
  expected: { sha256: string; size: string },
): Promise<void> {
  const verify = async () => {
    const info = await lstat(target);
    assert(info.isFile() && !info.isSymbolicLink(), '内容寻址目标不是普通文件');
    const digest = await fileDigest(target);
    assert(digest.sha256 === expected.sha256 && digest.size === expected.size, '同名资源内容冲突');
  };
  const existing = await lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    await verify();
    return;
  }
  try {
    await link(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') await verify();
    else if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EXDEV'].includes(code ?? '')) {
      try {
        await publishVerifiedCopy(source, target, expected.sha256);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await verify();
      }
    } else throw error;
  }
  await syncArchiveDirectory(dirname(target));
}
/** 复用已完成的下载，不另造 CDN 链路；正式资源按实际字节寻址。 */
export async function archiveResource(
  root: string,
  localPath: string | undefined,
  receipt: JsonObject,
  sourceRoot = root,
): Promise<JsonObject> {
  if (receipt.status === 'saved') {
    assert(receipt.path === `media/${receipt.sha256}`, '资源路径不符内容寻址');
    try {
      const source = await realpath(join(root, String(receipt.path))),
        canonicalRoot = await realpath(root);
      const within = relative(canonicalRoot, source);
      assert(
        within &&
          !within.startsWith(`..${sep}`) &&
          !isAbsolute(within) &&
          (await lstat(join(root, String(receipt.path)))).isFile(),
        '正式资源不是包内普通文件',
      );
      const actual = await fileDigest(source);
      assert(actual.sha256 === receipt.sha256 && actual.size === receipt.size, '正式资源校验失败');
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (!localPath) return receipt;
  assert(
    !isAbsolute(localPath) &&
      !localPath.includes('\\') &&
      !localPath.split('/').some((segment) => segment === '..' || segment === '.'),
    '资源路径越界',
  );
  const canonicalRoot = await realpath(sourceRoot);
  const candidate = join(sourceRoot, localPath);
  let source: string;
  try {
    source = await realpath(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const { path: _path, sha256: _sha256, ...metadata } = receipt;
      return { ...metadata, status: 'missing' };
    }
    throw error;
  }
  const inside = relative(canonicalRoot, source);
  assert(inside && !inside.startsWith(`..${sep}`) && !isAbsolute(inside), '资源路径越界');
  assert((await lstat(source)).isFile(), '资源不是普通文件');
  const digest = await fileDigest(source),
    path = `media/${digest.sha256}`,
    target = join(root, path);
  await mkdir(join(root, 'media'), { recursive: true });
  assert(
    (await lstat(join(root, 'media'))).isDirectory() &&
      !(await lstat(join(root, 'media'))).isSymbolicLink(),
    '资源目录不能是链接',
  );
  if (source !== target) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      const copied = await fileDigest(temporary);
      assert(
        copied.sha256 === digest.sha256 && copied.size === digest.size,
        '资源复制期间发生变化',
      );
      const handle = await open(temporary, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await publishArchiveResourceFile(temporary, target, digest);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
  return { ...receipt, status: 'saved', path, ...digest };
}
