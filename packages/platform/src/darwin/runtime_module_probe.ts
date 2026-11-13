import { execFile } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { QqRuntimeModules } from '@weq/native';

const execute = promisify(execFile);
const MAX_ACTIVE = 8;
const failure = () => new Error('无法确认运行中 QQ 的原生模块版本，请稍后重试。');

function canonicalFile(path: string): string {
  const resolved = realpathSync(path);
  if (!statSync(resolved).isFile()) throw failure();
  return resolved;
}

/** lsof 的 txt 字段来自目标进程的实际映射，不按安装目录或文件时间猜版本。 */
export function parseQqRuntimeModules(
  output: string,
  expectedPid: number,
  canonical: (path: string) => string = canonicalFile,
): QqRuntimeModules {
  let observed = false;
  const wrappers = new Set<string>();
  const majors = new Set<string>();
  for (const raw of output.split('\0')) {
    const field = raw.replace(/^\n+/, '');
    if (field.startsWith('p')) {
      if (field !== `p${expectedPid}`) throw failure();
      observed = true;
    }
    if (!field.startsWith('n')) continue;
    const path = field.slice(1);
    const name = basename(path);
    if (name !== 'wrapper.node' && name !== 'major.node') continue;
    if (!observed) throw failure();
    (name === 'wrapper.node' ? wrappers : majors).add(canonical(path));
  }
  if (wrappers.size !== 1 || majors.size !== 1) throw failure();
  return { wrapperPath: [...wrappers][0]!, majorPath: [...majors][0]! };
}

export function createQqRuntimeModuleProbe(
  read: (pid: number) => Promise<string> = async (pid) => {
    const { stdout } = await execute(
      '/usr/sbin/lsof',
      ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-F0pn'],
      { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
    );
    return stdout;
  },
  canonical: (path: string) => string = canonicalFile,
) {
  const active = new Map<number, Promise<QqRuntimeModules>>();
  return (pid: number): Promise<QqRuntimeModules> => {
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fff_ffff)
      return Promise.reject(failure());
    const current = active.get(pid);
    if (current) return current;
    if (active.size >= MAX_ACTIVE)
      return Promise.reject(new Error('QQ 模块探测繁忙，请稍后重试。'));
    const pending = Promise.resolve()
      .then(() => read(pid))
      .then((output) => parseQqRuntimeModules(output, pid, canonical))
      .finally(() => active.delete(pid));
    active.set(pid, pending);
    return pending;
  };
}

export const probeQqRuntimeModules = createQqRuntimeModuleProbe();
