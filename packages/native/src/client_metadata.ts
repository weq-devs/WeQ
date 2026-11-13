import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getNativeLogRoot, loadedNtHelperPath } from './loader';
import { InitStatus, type AppidInfo, type NtHelperBinding } from './types';

const execute = promisify(execFile);
const program = `const nt=require(process.argv[1]);
if(typeof nt.setLogPath==='function')nt.setLogPath(process.argv[3]);
if(nt.getInitStatus()!==${InitStatus.Success})throw new Error('native initialization failed');
process.stdout.write(JSON.stringify(nt.resolveAppidFromMajor(process.argv[2])));`;

function parseInfo(text: string): AppidInfo {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('无效的 QQ 版本元数据');
  const row = value as Record<string, unknown>;
  if (typeof row.appid !== 'string') throw new Error('无效的 QQ App ID 元数据');
  for (const key of ['version', 'build', 'qua'])
    if (row[key] !== undefined && typeof row[key] !== 'string')
      throw new Error('无效的 QQ 版本字段');
  return {
    appid: row.appid,
    version: row.version as string | undefined,
    build: row.build as string | undefined,
    qua: row.qua as string | undefined,
  };
}

export function createClientMetadataReader(
  locate: (nt: object) => string | undefined = loadedNtHelperPath,
  logRoot: () => string = getNativeLogRoot,
  timeoutMs = 5000,
) {
  const active = new Map<string, Promise<AppidInfo>>();
  return async (
    nt: Pick<NtHelperBinding, 'resolveAppidFromMajor'>,
    majorPath: string,
  ): Promise<AppidInfo> => {
    const addon = locate(nt);
    if (!addon) return nt.resolveAppidFromMajor(majorPath);
    const stat = statSync(majorPath, { bigint: true });
    const key = JSON.stringify([
      addon,
      majorPath,
      [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':'),
    ]);
    const current = active.get(key);
    if (current) return current;
    if (active.size >= 8) throw new Error('QQ 版本元数据读取繁忙，请稍后重试');
    const job = (async () => {
      const root = logRoot();
      await mkdir(root, { recursive: true });
      const log = join(root, `metadata_probe_${new Date().toISOString().slice(0, 10)}.log`);
      const { stdout } = await execute(process.execPath, ['-e', program, addon, majorPath, log], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        cwd: root,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      });
      return parseInfo(stdout);
    })().finally(() => active.delete(key));
    active.set(key, job);
    return job;
  };
}

export const resolveAppidFromMajorAsync = createClientMetadataReader();
