import { closeSync, openSync, readSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const QQ_DATA_ACCESS_SETTINGS =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export interface QqDataAccess {
  status: 'unsupported' | 'readable' | 'not-found' | 'denied' | 'error';
  applicationPath: string;
  issues: { path: string; code: string }[];
}

/** 必须在实际读取 QQ 数据的宿主进程里执行，不能用目录存在或外部进程代替验收。 */
export function checkQqDataAccess(options: {
  kind: string;
  roots: string[];
  executable: string;
}): QqDataAccess {
  const result: QqDataAccess = {
    status: 'unsupported',
    applicationPath: dirname(options.executable).endsWith('.app/Contents/MacOS')
      ? dirname(dirname(dirname(options.executable)))
      : options.executable,
    issues: [],
  };
  if (options.kind !== 'darwin') return result;
  let readable = false;
  const record = (path: string, error: unknown): void => {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN';
    if (code !== 'ENOENT' && code !== 'ENOTDIR') result.issues.push({ path, code });
  };
  for (const root of new Set(options.roots)) {
    const paths = [join(root, 'global/nt_db/login.db'), join(root, 'nt_qq/global/nt_db/login.db')];
    try {
      for (const name of readdirSync(root)) {
        if (name.startsWith('nt_qq_')) paths.push(join(root, name, 'nt_db/nt_msg.db'));
      }
    } catch (error) {
      record(root, error);
    }
    for (const path of paths) {
      try {
        const fd = openSync(path, 'r');
        try {
          readSync(fd, Buffer.alloc(1), 0, 1, 0);
          readable = true;
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        record(path, error);
      }
    }
  }
  result.status = result.issues.some(({ code }) => code === 'EPERM' || code === 'EACCES')
    ? 'denied'
    : result.issues.length
      ? 'error'
      : readable
        ? 'readable'
        : 'not-found';
  return result;
}
