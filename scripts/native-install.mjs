import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * marker（`.installed.json`）里的路径一律写正斜杠。
 *
 * 这份记录要跨平台比对：`fetch-native` 用 `join()` 造路径，Windows 上会得到
 * `native\win32\x64\nt_helper.node`，而 `dev-native` 的 `nativeFiles()` 用模板字符串
 * 得到正斜杠版本，两边精确匹配就永远失败（表现为每次 `pnpm dev` 重下 native 后报
 * 「文件清单不完整」）。统一成 POSIX 分隔符，`join()` 落盘时也能正确解析。
 */
export const markerPath = (path) => path.replaceAll('\\', '/');

/** 原生文件、配套资源与 marker 共用一笔安装事务，失败时恢复内容与原权限。 */
export async function installNativeFiles({ root, files, verify, replace = rename }) {
  const native = join(root, 'native');
  await mkdir(native, { recursive: true });
  const staging = await mkdtemp(join(native, '.fetch-install-'));
  const prepared = [];
  const changed = [];
  let retained = false;
  try {
    for (const [index, file] of files.entries()) {
      const destination = resolve(root, file.path);
      const path = relative(resolve(root), destination);
      if (
        !path ||
        path === '..' ||
        path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(path)
      )
        throw new Error(`安装目标超出仓库目录：${file.path}`);
      const incoming = join(staging, path);
      await mkdir(dirname(incoming), { recursive: true });
      await copyFile(file.source, incoming, constants.COPYFILE_FICLONE);
      await chmod(incoming, file.mode ?? 0o644);
      const backup = join(staging, `previous-${index}`);
      let existed = false;
      try {
        const info = await lstat(destination);
        if (!info.isFile()) throw new Error(`安装目标不是普通文件：${file.path}`);
        existed = true;
        await copyFile(destination, backup, constants.COPYFILE_FICLONE);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      prepared.push({ incoming, destination, backup, existed });
    }
    await verify?.(staging);
    for (const entry of prepared) {
      await mkdir(dirname(entry.destination), { recursive: true });
      await replace(entry.incoming, entry.destination);
      changed.push(entry);
    }
  } catch (error) {
    const errors = [error];
    for (const entry of changed.reverse()) {
      try {
        if (entry.existed) await rename(entry.backup, entry.destination);
        else await rm(entry.destination);
      } catch (restoreError) {
        retained = true;
        errors.push(restoreError);
      }
    }
    if (retained) throw new AggregateError(errors, `安装恢复未完成，恢复文件保留在 ${staging}`);
    throw error;
  } finally {
    if (!retained) await rm(staging, { recursive: true, force: true });
  }
}
