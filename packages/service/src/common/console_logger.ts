import type { LoggerContext, LogLevel } from './logger';
import { stripVTControlCharacters } from 'node:util';
import { writeSync } from 'node:fs';

const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const secret =
  /cookie|authorization|password|secret|token|rkey|(?:^|_)a2$|(?:^|_)d2(?:key)?$|skey|credential|(?:api|access|private|encryption|client|db|database|decrypt)[_-]?key/i;
const omitted =
  /^(?:body|text|content|payload|response|raw|data|bytes|buffer|message|messages|messageText|plainText|markdown|html|prompt|completion|input|output|args|params)$/i;

function safeText(value: string, limit = 1000): string {
  return stripVTControlCharacters(value.slice(0, limit * 2))
    .replace(/https?:\/\/[^\s"'<>]+/g, (text) => {
      try {
        const url = new URL(text);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[URL]';
      }
    })
    .replace(/\b(Bearer\s+)[^\s,;]+/gi, '$1[hidden]')
    .replace(
      /\b(cookie|password|secret|token|rkey|d2key|p_skey|skey)\s*[=:]\s*[^\s,;]+/gi,
      '$1=[hidden]',
    )
    .split('')
    .filter(
      (char) =>
        (char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) || char === '\n' || char === '\t',
    )
    .join('')
    .slice(0, limit);
}

/** 仅构造展示投影；不修改业务对象，也不沿循环引用继续展开。 */
export function projectConsoleContext(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let characters = 12000;
  const visit = (item: unknown, key: string, depth: number): unknown => {
    if (++nodes > 256 || characters <= 0) return '[truncated]';
    if (secret.test(key)) return '[hidden]';
    if (omitted.test(key)) return '[omitted]';
    if (typeof item === 'string') {
      const text = safeText(item, Math.min(characters, /stack/i.test(key) ? 6000 : 1000));
      characters -= text.length;
      return text;
    }
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (typeof item !== 'object') return undefined;
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return '[binary]';
    if (seen.has(item)) return '[circular]';
    if (depth >= 4) return '[truncated]';
    seen.add(item);
    if (item instanceof Error)
      return visit(
        { name: item.name, errorMessage: item.message, stack: item.stack },
        key,
        depth + 1,
      );
    if (Array.isArray(item)) return item.slice(0, 12).map((child) => visit(child, '', depth + 1));
    return Object.fromEntries(
      Object.entries(item)
        .slice(0, 24)
        .map(([name, child]) => [safeText(name, 80), visit(child, name, depth + 1)]),
    );
  };
  return visit(value, '', 0);
}

export interface ConsoleLoggerOptions {
  development: boolean;
  processName: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sink?: (line: string) => void;
  color?: boolean;
  infoScopes?: ReadonlySet<string>;
}

export function createConsoleLogger(options: ConsoleLoggerOptions) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const sink =
    options.sink ??
    ((line: string) => {
      writeSync(process.stderr.fd, line);
    });
  const enabled =
    env.WEQ_LOG_CONSOLE === '1' || (env.WEQ_LOG_CONSOLE !== '0' && options.development);
  const minimum = levels.includes(env.WEQ_LOG_LEVEL as LogLevel)
    ? (env.WEQ_LOG_LEVEL as LogLevel)
    : 'info';
  const scopeText = env.WEQ_LOG_SCOPES?.trim() ?? '';
  const validScopes = /^(?:[\w.-]+(?:\s*,\s*[\w.-]+)*)?$/.test(scopeText);
  const scopes = new Set(
    (validScopes ? scopeText : '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  );
  const color = (options.color ?? process.stderr.isTTY) && env.NO_COLOR === undefined;
  const pending = new Map<
    string,
    { at: number; count: number; level: LogLevel; message: string; context: LoggerContext }
  >();
  const output = (level: LogLevel, message: string, context: LoggerContext) => {
    try {
      const time = new Date(now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 23);
      const label = level.toUpperCase();
      const painted = color
        ? `\x1b[${level === 'error' ? 31 : level === 'warn' ? 33 : 36}m${label}\x1b[0m`
        : label;
      sink(
        `${time} +08:00 ${painted} [${safeText(options.processName, 40)}:${process.pid}] [${safeText(context.scope ?? 'app', 80)}] ${safeText(message).replace(/\s+/g, ' ')} ${JSON.stringify(projectConsoleContext(context))}\n`,
      );
    } catch {
      // 终端断开或展示对象不可读不能影响业务。
    }
  };
  const flush = () => {
    for (const entry of pending.values()) {
      if (entry.count)
        output(entry.level, '重复日志汇总', {
          ...entry.context,
          repeated: entry.count,
          originalMessage: entry.message,
        });
    }
    pending.clear();
  };
  const timer = enabled
    ? setInterval(() => {
        for (const [key, entry] of pending) {
          if (now() - entry.at < 30_000) continue;
          if (entry.count)
            output(entry.level, '重复日志汇总', {
              ...entry.context,
              repeated: entry.count,
              originalMessage: entry.message,
            });
          pending.delete(key);
        }
      }, 30_000)
    : null;
  timer?.unref();
  const invalid =
    !validScopes ||
    (env.WEQ_LOG_CONSOLE !== undefined && !['0', '1'].includes(env.WEQ_LOG_CONSOLE)) ||
    (env.WEQ_LOG_LEVEL !== undefined && !levels.includes(env.WEQ_LOG_LEVEL as LogLevel));
  if (invalid)
    output('warn', '日志环境变量无效，已回落默认配置', {
      scope: 'logger',
      event: 'log-config-invalid',
    });
  return {
    write(level: LogLevel, message: string, context: LoggerContext = {}) {
      if (!enabled || levels.indexOf(level) < levels.indexOf(minimum)) return;
      if (
        (level === 'info' || level === 'debug') &&
        scopes.size &&
        !scopes.has(context.scope ?? 'app')
      )
        return;
      if (
        level === 'info' &&
        !scopes.size &&
        minimum !== 'debug' &&
        options.infoScopes &&
        !options.infoScopes.has(context.scope ?? 'app')
      )
        return;
      if (level === 'warn' || level === 'error') {
        const key = JSON.stringify(
          projectConsoleContext({
            level,
            scope: context.scope,
            event: context.event ?? message,
            accountUin: context.accountUin,
            mediaId: context.mediaId,
            path: context.path,
            code: context.code,
            errorName: context.errorName,
            errorMessage: context.errorMessage,
            taskId: context.taskId,
            pid: context.pid,
            reason: context.reason,
          }),
        );
        const old = pending.get(key);
        if (old && now() - old.at < 30_000) {
          old.count++;
          return;
        }
        if (old?.count)
          output(old.level, '重复日志汇总', {
            ...old.context,
            repeated: old.count,
            originalMessage: old.message,
          });
        if (pending.size >= 512) {
          const first = pending.entries().next().value;
          if (first) {
            if (first[1].count)
              output(first[1].level, '重复日志汇总', {
                ...first[1].context,
                repeated: first[1].count,
              });
            pending.delete(first[0]);
          }
        }
        pending.set(key, {
          at: now(),
          count: 0,
          level,
          message: safeText(message),
          context: projectConsoleContext(context) as LoggerContext,
        });
      }
      output(level, message, context);
    },
    dispose() {
      if (timer) clearInterval(timer);
      flush();
    },
    flush,
  };
}
