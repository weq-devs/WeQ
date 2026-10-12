import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface OwnedChildOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Sensitive stdin is never included in errors or logs. */
  input?: string;
  env?: NodeJS.ProcessEnv;
}
export interface OwnedChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Control only the process created here; wait for close before releasing it. */
export function runOwnedChild(
  command: string,
  args: readonly string[],
  options: OwnedChildOptions = {},
): Promise<OwnedChildResult> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const maxBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0
  )
    throw new Error('子进程运行限制无效。');
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env: options.env });
    const outDecoder = new StringDecoder('utf8'),
      errDecoder = new StringDecoder('utf8');
    let stdout = '',
      stderr = '',
      bytes = 0;
    let failure: unknown = null;
    const terminate = (error: unknown): void => {
      if (failure !== null) return;
      failure = error;
      // Never signal a target QQ PID, use a process group or escalate to SIGKILL.
      child.kill('SIGTERM');
    };
    const cancel = (): void => terminate(options.signal?.reason ?? new Error('读取已取消。'));
    const timer = setTimeout(
      () => terminate(new Error('读取 worker 超时，已请求退出。')),
      timeoutMs,
    );
    options.signal?.addEventListener('abort', cancel, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
    };
    const collect = (chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        terminate(new Error('读取 worker 输出超过限制。'));
        return;
      }
      if (stream === 'stdout') stdout += outDecoder.write(chunk);
      else stderr += errDecoder.write(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => collect(chunk, 'stderr'));
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code, signal) => {
      cleanup();
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      if (failure !== null) reject(failure);
      else resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
    if (options.signal?.aborted) cancel();
  });
}
