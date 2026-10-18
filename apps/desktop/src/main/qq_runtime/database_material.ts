import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { NtHelperBinding } from '@weq/native';

/** 只接受本实例数据根中的消息库，不扫描其他账号目录或 QQ 的默认目录。 */
export async function readOwnDatabaseKey(
  nt: Pick<NtHelperBinding, 'scanKeyFromDatabase'>,
  dataRoot: string,
  candidates: readonly string[],
): Promise<{ dbPath: string; dbKey: string }> {
  if (!isAbsolute(dataRoot) || candidates.length < 1 || candidates.length > 2)
    throw new Error('托管数据库路径无效');
  const root = await realpath(dataRoot);
  const found: string[] = [];
  for (const candidate of candidates) {
    const local = relative(resolve(dataRoot), resolve(candidate));
    const parts = local.split(sep);
    if (
      !isAbsolute(candidate) ||
      basename(candidate) !== 'nt_msg.db' ||
      !(
        (parts.length === 2 && parts[0] === 'nt_db') ||
        (parts.length === 3 && /^nt_qq_[a-f0-9]+$/.test(parts[0]!))
      ) ||
      parts.at(-2) !== 'nt_db'
    )
      throw new Error('托管数据库路径无效');
    try {
      const path = await realpath(candidate);
      const actual = relative(root, path);
      if (!actual || actual === '..' || actual.startsWith(`..${sep}`) || isAbsolute(actual))
        throw new Error('托管数据库不能指向数据根外部');
      const file = await stat(path);
      if (file.isFile() && file.size >= 4096) found.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  const unique = [...new Set(found)];
  if (unique.length !== 1)
    throw new Error(unique.length ? '托管数据库目录存在歧义' : '托管消息数据库尚未创建');
  const dbPath = unique[0]!;
  const result = await nt.scanKeyFromDatabase(dbPath, process.pid);
  if (!result.success || typeof result.key !== 'string' || !/^[\x20-\x7e]{16}$/.test(result.key))
    throw new Error('托管数据库密钥尚未就绪');
  return { dbPath, dbKey: result.key };
}
