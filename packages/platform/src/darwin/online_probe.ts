import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const TIMEOUT_MS = 2000;
const MAX_OUTPUT = 256 * 1024;
const MAX_ACTIVE_PROBES = 8;

/** lsof 的 NUL 字段格式；只有进程名与账号数据库路径同时匹配才确认在线。 */
export function parseQqDbHolders(output: string, dbPath: string): number | null {
  let pid: number | null = null;
  let name = '';
  const holders = new Set<number>();
  for (const raw of output.split('\0')) {
    const field = raw.startsWith('\n') ? raw.slice(1) : raw;
    if (field.startsWith('p')) {
      const value = field.slice(1);
      pid = /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
      name = '';
    } else if (field.startsWith('c')) name = field.slice(1);
    else if (
      field.startsWith('n') &&
      field.slice(1) === dbPath &&
      pid &&
      name.toLowerCase() === 'qq'
    )
      holders.add(pid);
  }
  return holders.size === 1 ? [...holders][0]! : null;
}

type Spawn = (command: string, args: string[]) => ChildProcess;

/** 按账号合并探测，超时子进程真正退出前仍占用名额，避免堆积。失败抛错而非冒充离线。 */
export function createQqOnlineProbe(
  launch: Spawn = (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  canonical: (path: string) => string = realpathSync,
  timeoutMs = TIMEOUT_MS,
) {
  const active = new Map<string, { promise: Promise<number | null>; settled: boolean }>();
  return (dbPath: string): Promise<number | null> => {
    let target: string;
    try {
      target = canonical(dbPath);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return Promise.resolve(null);
      return Promise.reject(new Error('QQ 在线探测无法解析数据库路径。'));
    }
    const existing = active.get(target);
    if (existing)
      return existing.settled
        ? Promise.reject(new Error('QQ 在线探测子进程尚未退出。'))
        : existing.promise;
    if (active.size >= MAX_ACTIVE_PROBES)
      return Promise.reject(new Error('QQ 在线探测繁忙，稍后重试。'));
    let finish: (pid: number | null) => void;
    let reject: (error: Error) => void;
    const promise = new Promise<number | null>((resolve, fail) => {
      finish = resolve;
      reject = fail;
    });
    const job = { promise, settled: false };
    active.set(target, job);
    let child: ChildProcess | null = null;
    let stage = 'pgrep';
    let settled = false;
    const settle = (pid: number | null) => {
      if (!settled) {
        settled = true;
        job.settled = true;
        finish(pid);
      }
    };
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        job.settled = true;
        reject(new Error(message));
      }
    };
    const clear = () => {
      if (active.get(target) === job) active.delete(target);
    };
    const timer = setTimeout(() => {
      fail(`QQ 在线探测超时（${stage}，限时 ${timeoutMs}ms），尚未确认是否离线。`);
      child?.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    const run = (command: string, args: string[], done: (output: string) => void) => {
      stage = command.slice(command.lastIndexOf('/') + 1);
      let process: ChildProcess;
      try {
        process = launch(command, args);
        child = process;
      } catch {
        clearTimeout(timer);
        fail('QQ 在线探测启动失败。');
        clear();
        return;
      }
      let output = '',
        bytes = 0,
        failed = false,
        hasStderr = false;
      const decoder = new StringDecoder('utf8');
      process.stdout?.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > MAX_OUTPUT) {
          failed = true;
          fail('QQ 在线探测输出超出限制。');
          process.kill('SIGKILL');
          return;
        }
        output += decoder.write(data);
      });
      process.stderr?.on('data', (data: Buffer) => {
        if (data.length) hasStderr = true;
      });
      process.once('error', () => {
        failed = true;
        fail('QQ 在线探测子进程运行失败。');
      });
      process.once('close', (code) => {
        output += decoder.end();
        child = null;
        if (settled || failed || code !== 0) {
          clearTimeout(timer);
          // pgrep/lsof 查无匹配均返回 1；只有无输出、无诊断时才视为确定未发现。
          if (!settled && !failed && code === 1 && !output && !hasStderr) settle(null);
          else fail(`QQ 在线探测失败（${stage}，退出码 ${code}），尚未确认是否离线。`);
          clear();
          return;
        }
        done(output);
      });
    };
    run('/usr/bin/pgrep', ['-x', 'QQ'], (output) => {
      const pids = [
        ...new Set(
          output
            .trim()
            .split(/\s+/)
            .filter((pid) => /^[1-9]\d*$/.test(pid)),
        ),
      ];
      if (!pids.length || pids.length > 64) {
        clearTimeout(timer);
        fail('QQ 在线探测进程列表异常。');
        clear();
        return;
      }
      run(
        '/usr/sbin/lsof',
        ['-nP', '-a', '-p', pids.join(','), '-F0pcn', '--', target],
        (output) => {
          clearTimeout(timer);
          settle(parseQqDbHolders(output, target));
          clear();
        },
      );
    });
    return promise;
  };
}
