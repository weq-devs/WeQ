import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { stripVTControlCharacters } from 'node:util';
import { constants } from 'node:os';
import type { Readable } from 'node:stream';
import {
  formatConsoleRecord,
  projectConsoleContext,
  type LoggerContext,
  type LogLevel,
} from '@weq/service/console-output';

export function terminalColor(stream: 'stdout' | 'stderr', env = process.env): boolean {
  const inherited = env[stream === 'stdout' ? 'WEQ_DEV_STDOUT_TTY' : 'WEQ_DEV_STDERR_TTY'];
  return (
    env.NO_COLOR === undefined &&
    (inherited === undefined ? Boolean(process[stream].isTTY) : inherited === '1')
  );
}

export function developmentRecord(
  level: LogLevel,
  message: string,
  context: LoggerContext,
  color = terminalColor('stderr'),
): string {
  return formatConsoleRecord(level, message, projectConsoleContext(context) as LoggerContext, {
    now: Date.now(),
    color,
    details: process.env.WEQ_LOG_LEVEL === 'debug',
  });
}

function timingBoilerplate(line: string): boolean {
  return /^(?:The slowest callbacks,|Additional callback time came from callbacks under |See https:\/\/rolldown\.rs\/reference\/InputOptions\.checks#bundlertimings)/.test(
    line.trim(),
  );
}

/** 已知构建警告压成摘要，其他警告和定位仍原样输出。 */
export function summarizeDevelopmentBuildWarning(text: string): string {
  const chunk = /Some chunks are larger than ([\d.]+\s*kB) after minification/.exec(text);
  if (chunk) return `部分构建块压缩后超过 ${chunk[1]}`;
  const timing =
    /\[PLUGIN_TIMINGS\] JavaScript callbacks ran for ([\d.]+s) of this ([\d.]+s) build \(([^)]+)\)\./.exec(
      text,
    );
  if (!timing) return text;
  const names: Record<string, string> = {
    'weq-remote-web-assets': 'Web 资源',
    'vite:esm-shim': 'ESM 兼容',
  };
  const callbacks: string[] = [];
  const diagnostics: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === timing[0] || timingBoilerplate(trimmed)) continue;
    const callback = /^- plugin (.+) \S+ \([^,]+, ([\d.]+s), \d+ calls?\)$/.exec(trimmed);
    if (callback) callbacks.push(`${names[callback[1]!] ?? callback[1]} ${callback[2]}`);
    else diagnostics.push(line);
  }
  const summary = `构建 ${timing[2]}，插件 ${timing[1]}（${timing[3]}）`;
  return [callbacks.length ? `${summary}：${callbacks.join('，')}` : summary, ...diagnostics].join(
    '\n',
  );
}

/** 仅处理开发子进程的行协议，不接管应用的 console 或结构化文件日志。 */
export function createDevelopmentOutput(
  sink: (line: string) => void,
  color: boolean,
  maxLine = 16_384,
) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let afterCR = false;
  let continuation = false;
  let timingReport = false;
  const emit = (line: string) => {
    const text = stripVTControlCharacters(line);
    if (!text.trim()) return;
    const debug = process.env.WEQ_LOG_LEVEL === 'debug';
    if (timingReport && (timingBoilerplate(text) || /^\s*- plugin /.test(text))) {
      if (debug || !timingBoilerplate(text)) sink(`         ${text.trim()}\n`);
      return;
    }
    if (!/^ {9}\S/.test(text)) timingReport = text.includes('[PLUGIN_TIMINGS]');
    if (
      process.env.WEQ_LOG_LEVEL !== 'debug' &&
      /^(?:-----|electron (?:main process|preload scripts) (?:re)?built successfully)$/.test(
        text.trim(),
      )
    )
      return;
    if (/^\d{2}:\d{2}:\d{2} (?:DEBUG|INFO |WARN |ERROR) /.test(text) || /^ {9}\S/.test(text)) {
      sink(`${color ? line : text}\n`);
      return;
    }
    const system = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ (\S+)\[\d+:\d+\] (.*)$/.exec(text);
    const vite = /^\s*(?:\d{1,2}:\d{2}:\d{2}(?:\s*[AP]M)?\s+)?\[vite\]\s*(.*)$/.exec(text);
    const scope = system ? 'electron-system' : vite ? 'vite' : 'dev-process';
    const lifecycle: Record<string, string> = {
      'starting electron app...': '正在启动应用',
      'restarting electron app...': '正在重启应用',
      'reloading electron renderer...': '正在重新加载界面',
    };
    const message = system
      ? `${system[1]}: ${system[2]}`
      : vite
        ? vite[1]!
        : (lifecycle[text.trim()] ?? text);
    if (continuation || /^\s+at\s|^\s*\^/.test(text)) sink(`         ${text}\n`);
    else {
      const level = /\b(?:error|fatal|failed)\b/i.test(message)
        ? 'error'
        : timingReport || /\bwarn(?:ing)?\b/i.test(message)
          ? 'warn'
          : 'info';
      sink(
        developmentRecord(
          level,
          debug ? message : summarizeDevelopmentBuildWarning(message),
          { scope },
          color,
        ),
      );
    }
  };
  const consume = (text: string) => {
    for (const char of text) {
      if (afterCR && char === '\n') {
        afterCR = false;
        continue;
      }
      afterCR = char === '\r';
      if (char === '\n' || char === '\r') {
        emit(pending);
        pending = '';
        continuation = false;
      } else {
        pending += char;
        if (pending.length >= maxLine) {
          emit(pending);
          pending = '';
          continuation = true;
        }
      }
    }
  };
  return {
    write(chunk: Buffer | string) {
      consume(typeof chunk === 'string' ? chunk : decoder.write(chunk));
    },
    end() {
      consume(decoder.end());
      emit(pending);
      pending = '';
    },
  };
}

export function developmentChildEnvironment(env = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {
    ...env,
    WEQ_DEV_CONSOLE: '1',
    WEQ_DEV_STDOUT_TTY: env.WEQ_DEV_STDOUT_TTY ?? (process.stdout.isTTY ? '1' : '0'),
    WEQ_DEV_STDERR_TTY: env.WEQ_DEV_STDERR_TTY ?? (process.stderr.isTTY ? '1' : '0'),
  };
  if (env.NO_COLOR !== undefined) delete next.FORCE_COLOR;
  else if (terminalColor('stdout', env) || terminalColor('stderr', env))
    next.FORCE_COLOR = env.FORCE_COLOR ?? '1';
  return next;
}

export function superviseDevelopmentChild(
  child: ChildProcess,
  processGroup = false,
): Promise<number> {
  return new Promise((resolve) => {
    const connect = (source: Readable | null, target: NodeJS.WriteStream, color: boolean) => {
      let draining = false;
      const resume = () => {
        draining = false;
        source?.resume();
      };
      const output = createDevelopmentOutput((line) => {
        if (!target.write(line) && !draining) {
          draining = true;
          source?.pause();
          target.once('drain', resume);
        }
      }, color);
      source?.on('data', output.write);
      return () => {
        output.end();
        target.removeListener('drain', resume);
      };
    };
    const endOut = connect(child.stdout, process.stdout, terminalColor('stdout'));
    const endErr = connect(child.stderr, process.stderr, terminalColor('stderr'));
    let interrupted: NodeJS.Signals | undefined;
    let failedToSpawn = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (processGroup && child.pid) {
        try {
          process.kill(-child.pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      } else child.kill(signal);
    };
    // POSIX 独立进程组只包含本次开发子树，支持父进程收到单独终止信号时清理。
    const onSignal = (signal: NodeJS.Signals) => {
      interrupted = signal;
      kill(signal);
      killTimer ??= setTimeout(() => kill('SIGKILL'), 5000);
      killTimer.unref();
    };
    const onInt = () => onSignal('SIGINT');
    const onTerm = () => onSignal('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const onHup = () => onSignal('SIGHUP');
    if (process.platform !== 'win32') process.on('SIGHUP', onHup);
    const onExit = () => kill('SIGTERM');
    process.once('exit', onExit);
    child.once('exit', () => {
      if (processGroup) {
        kill('SIGTERM');
        killTimer ??= setTimeout(() => kill('SIGKILL'), 5000);
        killTimer.unref();
      }
    });
    child.on('error', (error) => {
      failedToSpawn = true;
      process.stderr.write(developmentRecord('error', error.message, { scope: 'startup' }));
    });
    child.once('close', (code, signal) => {
      endOut();
      endErr();
      if (killTimer) clearTimeout(killTimer);
      process.removeListener('SIGINT', onInt);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGHUP', onHup);
      process.removeListener('exit', onExit);
      const finalSignal = signal ?? interrupted;
      resolve(failedToSpawn ? 1 : finalSignal ? 128 + constants.signals[finalSignal] : (code ?? 1));
    });
  });
}

export async function launchDevelopment(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const processGroup = process.platform !== 'win32';
  return superviseDevelopmentChild(
    spawn(command, args, {
      cwd,
      env: developmentChildEnvironment(env),
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: processGroup,
    }),
    processGroup,
  );
}
