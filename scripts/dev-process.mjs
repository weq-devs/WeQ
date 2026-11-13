import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { formatConsoleHeader } from '../packages/service/src/common/console_header.mjs';

export function startupLog(
  message,
  level = 'info',
  scope = 'startup',
  { continuation = false } = {},
) {
  if (level === 'debug' && process.env.WEQ_LOG_LEVEL !== 'debug') return;
  const sink = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  const color = Boolean(sink.isTTY) && process.env.NO_COLOR === undefined;
  for (const line of String(message).split(/\r?\n/)) {
    if (line.trim())
      sink.write(
        continuation
          ? `         ${line}\n`
          : `${formatConsoleHeader(level, line, scope, { now: Date.now(), color })}\n`,
      );
  }
}

/** 子进程输出有界分行，兼容 UTF-8 分块和覆盖式进度；已有应用日志不再套行头。 */
export function commandOutput(log, scope, { env = process.env } = {}) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let diagnostic;
  let warnings = 0;
  const emit = () => {
    const original = pending;
    const text = stripVTControlCharacters(pending);
    pending = '';
    if (!text.trim()) return;
    const debug = env.WEQ_LOG_LEVEL === 'debug';
    if (
      !debug &&
      ((scope === 'native' && /^ {3,}(?:Compiling|Checking|Finished|Running|Fresh)\s/.test(text)) ||
        /^\$ node scripts\/build-bot\.mjs\b/.test(text))
    )
      return;
    if (!debug && warnings && /^warning: .* generated \d+ warnings?/.test(text)) return;
    if (/^\d{2}:\d{2}:\d{2} (?:DEBUG|INFO |WARN |ERROR) /.test(text) || /^ {9}\S/.test(text)) {
      const sink = /^\d{2}:\d{2}:\d{2} (?:WARN |ERROR) /.test(text)
        ? process.stderr
        : process.stdout;
      sink.write(`${sink.isTTY && process.env.NO_COLOR === undefined ? original : text}\n`);
      return;
    }
    const level = /(?:^|\s)(?:error(?:\[|:)|fatal:|ERR_PNPM_|✘)/i.test(text)
      ? 'error'
      : /(?:^|\s)(?:warning(?:\[|:)|warn\b|⚠)/i.test(text)
        ? 'warn'
        : 'info';
    const continuation =
      !debug && diagnostic && /^\s+(?:-->|:::|\||\d+\s*\||=|\^|\.\.\.)/.test(text);
    if (level === 'warn') warnings++;
    if (!continuation) diagnostic = level === 'warn' || level === 'error' ? level : undefined;
    log(text, continuation ? diagnostic : level, scope, { continuation: Boolean(continuation) });
  };
  const consume = (text) => {
    for (const char of text) {
      if (char === '\r' || char === '\n') emit();
      else {
        pending += char;
        if (pending.length >= 16_384) emit();
      }
    }
  };
  return {
    write: (chunk) => consume(decoder.write(chunk)),
    end() {
      consume(decoder.end());
      emit();
    },
  };
}

/** 不经过 shell，带空格路径和参数在 Windows / POSIX 使用同一传递方式。 */
export function runCommand(
  command,
  args,
  {
    cwd,
    env = process.env,
    log = startupLog,
    scope = 'startup',
    capture = false,
    progressIntervalMs = 15_000,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let interrupted;
    let timer;
    const out = commandOutput(log, scope, { env });
    const err = commandOutput(log, scope, { env });
    const started = performance.now();
    const progress =
      !capture &&
      command === 'cargo' &&
      ['build', 'run'].includes(args[0]) &&
      env.WEQ_LOG_LEVEL !== 'debug'
        ? setInterval(
            () =>
              log(
                `构建任务仍在进行（已耗时 ${Math.round((performance.now() - started) / 1000)}s）`,
                'info',
                scope,
              ),
            progressIntervalMs,
          ).unref()
        : undefined;
    const collect = (stream, output, isError) =>
      stream.on('data', (chunk) => {
        if (!capture) output.write(chunk);
        else if (isError) stderr = (stderr + chunk).slice(-8 * 1024 * 1024);
        else {
          stdout += chunk;
          if (stdout.length > 8 * 1024 * 1024) {
            child.kill();
            reject(new Error('命令输出超过 8 MB'));
          }
        }
      });
    collect(child.stdout, out, false);
    collect(child.stderr, err, true);
    const kill = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          }).on('error', () => child.kill());
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(signal);
      }
    };
    const signal = (value) => {
      interrupted = value;
      kill(value);
      timer ??= setTimeout(() => kill('SIGKILL'), 3_000).unref();
    };
    const onInt = () => signal('SIGINT');
    const onTerm = () => signal('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const cleanup = () => {
      clearInterval(progress);
      clearTimeout(timer);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      if (!capture) {
        out.end();
        err.end();
      }
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (status, exitSignal) => {
      cleanup();
      const code = interrupted || exitSignal;
      if (status === 0 && !code) resolve(stdout);
      else
        reject(
          Object.assign(
            new Error(
              `${command} 执行失败（${code ?? status}）${capture && stderr ? `\n${stderr.trim()}` : ''}`,
            ),
            {
              exitCode: code ? 128 + (constants.signals[code] ?? 1) : status || 1,
            },
          ),
        );
    });
  });
}

export function pnpmCommand(args, env = process.env) {
  const cli = env.npm_execpath;
  if (!cli)
    throw new Error('请通过 pnpm dev 运行；直接执行 Node 时需设置 npm_execpath 为 pnpm 入口。');
  if (/\.cmd$/i.test(cli))
    throw new Error('pnpm 入口是 .cmd；请由 pnpm dev 启动以获得实际的 pnpm 可执行入口。');
  return /\.[cm]?js$/i.test(cli) ? [process.execPath, [cli, ...args]] : [cli, args];
}
