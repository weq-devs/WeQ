import { execFileSync } from 'node:child_process';

/** 仅识别启动来源，不将父进程推断冒充 macOS 的实时 TCC 责任进程。 */
export function findMacLaunchApplication(snapshot: string, pid: number): string | null {
  const processes = new Map<number, { parent: number; executable: string }>();
  for (const line of snapshot.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (match)
      processes.set(Number(match[1]), { parent: Number(match[2]), executable: match[3]!.trim() });
  }
  const seen = new Set<number>([pid]);
  let parent = processes.get(pid)?.parent;
  for (let depth = 0; parent && parent > 1 && depth < 32; depth++) {
    if (seen.has(parent)) break;
    seen.add(parent);
    const process = processes.get(parent);
    if (!process) break;
    const app = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(process.executable);
    if (app) return app[1]!;
    parent = process.parent;
  }
  return null;
}

let cached: string | null | undefined;
export function macLaunchApplication(): string | null {
  if (process.platform !== 'darwin') return null;
  if (cached !== undefined) return cached;
  try {
    cached = findMacLaunchApplication(
      execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,comm='], {
        encoding: 'utf8',
        timeout: 1000,
        maxBuffer: 1024 * 1024,
      }),
      process.pid,
    );
  } catch {
    cached = null;
  }
  return cached;
}
