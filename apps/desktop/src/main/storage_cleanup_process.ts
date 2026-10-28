import { execFileSync } from 'node:child_process';
import { posix, win32 } from 'node:path';

const NO_PROCESS = '__WEQ_CLEANUP_PROCESS_NOT_FOUND__';

type RunCommand = (
  file: string,
  args: string[],
  options: { encoding: 'utf8'; timeout: number; windowsHide?: boolean; maxBuffer?: number },
) => string;

/** CommandLine 必须包含独立的 worker 路径参数，而非恰好含有相同子串。 */
export function commandRunsCleanupWorker(
  commandLine: string,
  worker: string,
  platform: NodeJS.Platform,
): boolean {
  const normalize = (value: string) =>
    platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
  const command = normalize(commandLine);
  const expected = normalize(worker);
  let at = command.indexOf(expected);
  while (at !== -1) {
    const before = command[at - 1];
    const after = command[at + expected.length];
    if (
      (before === undefined || /[\s"']/.test(before)) &&
      (after === undefined || /[\s"']/.test(after))
    )
      return true;
    at = command.indexOf(expected, at + 1);
  }
  return false;
}

/**
 * PID 本身不是进程身份：Windows 的 PID 重用可能把无关程序误判为清理助手。
 * 对现存 PID 查询实际命令行，仅允许该 worker 的独立进程参数匹配。
 * 无法安全检查时抛错，上层保持锁并拒绝启动；不会误放行正在清理的助手。
 */
export function isStorageCleanupWorkerProcess(
  pid: number,
  worker: string,
  platform: NodeJS.Platform = process.platform,
  run: RunCommand = execFileSync,
): boolean {
  const path = platform === 'win32' ? win32 : posix;
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof worker !== 'string' ||
    !path.isAbsolute(worker) ||
    path.basename(worker).toLowerCase() !== 'storagecleanupworker.mjs'
  ) {
    throw new Error('清除助手锁文件包含无效的进程身份');
  }

  let command: string;
  if (platform === 'win32') {
    // pid 已验证为正整数，绝不把锁文件里的字符串插入 PowerShell 脚本。
    const script =
      '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);' +
      "$ErrorActionPreference='Stop';" +
      `$candidate=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';` +
      `if ($null -eq $candidate) { [Console]::Out.Write('${NO_PROCESS}') }` +
      "elseif ([string]::IsNullOrWhiteSpace($candidate.CommandLine)) { throw 'CommandLine unavailable' }" +
      'else { [Console]::Out.Write($candidate.CommandLine) }';
    command = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 128 * 1024,
    });
    if (command.trim() === NO_PROCESS) return false;
  } else {
    command = run('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2000,
    });
  }
  if (!command.trim()) throw new Error('无法读取清除助手的进程命令行');
  return commandRunsCleanupWorker(command, worker, platform);
}
