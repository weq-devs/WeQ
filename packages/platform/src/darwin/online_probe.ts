import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const TIMEOUT_MS = 2000;
const MAX_OUTPUT = 256 * 1024;

/** lsof's NUL-delimited field format; a QQ name alone never proves account ownership. */
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

/** Keep a timed-out child registered until it actually exits: never pile up stuck probes. */
export function createQqOnlineProbe(
  launch: Spawn = (command, args) => spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
  canonical: (path: string) => string = realpathSync,
  timeoutMs = TIMEOUT_MS,
) {
  let active: { key: string; promise: Promise<number | null> } | null = null;
  return (dbPath: string): Promise<number | null> => {
    let target: string;
    try {
      target = canonical(dbPath);
    } catch {
      return Promise.resolve(null);
    }
    if (active) return active.key === target ? active.promise : Promise.resolve(null);
    let finish: (pid: number | null) => void;
    const promise = new Promise<number | null>((resolve) => {
      finish = resolve;
    });
    const job = { key: target, promise };
    active = job;
    let child: ChildProcess | null = null;
    let settled = false;
    const settle = (pid: number | null) => {
      if (!settled) {
        settled = true;
        finish(pid);
      }
    };
    const clear = () => {
      if (active === job) active = null;
    };
    const timer = setTimeout(() => {
      settle(null);
      child?.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    const run = (command: string, args: string[], done: (output: string) => void) => {
      let process: ChildProcess;
      try {
        process = launch(command, args);
        child = process;
      } catch {
        clearTimeout(timer);
        settle(null);
        clear();
        return;
      }
      let output = '',
        bytes = 0,
        failed = false;
      const decoder = new StringDecoder('utf8');
      process.stdout?.on('data', (data: Buffer) => {
        bytes += data.length;
        if (bytes > MAX_OUTPUT) {
          failed = true;
          settle(null);
          process.kill('SIGKILL');
          return;
        }
        output += decoder.write(data);
      });
      process.stderr?.resume();
      process.once('error', () => {
        failed = true;
        settle(null);
      });
      process.once('close', (code) => {
        output += decoder.end();
        child = null;
        if (settled || failed || code !== 0) {
          clearTimeout(timer);
          settle(null);
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
        settle(null);
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
