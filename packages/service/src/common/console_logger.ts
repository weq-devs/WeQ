import type { LoggerContext, LogLevel } from './logger';
import { stripVTControlCharacters } from 'node:util';
import { writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { consoleTimingLabels, formatConsoleRecord, type ConsoleSummary } from './console_format';
import { terminalColor } from './console_header.mjs';

const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const secret =
  /cookie|authorization|password|secret|token|rkey|(?:^|_)a2$|(?:^|_)d2(?:key)?$|skey|credential|(?:api|access|private|encryption|client|db|database|decrypt)[_-]?key/i;
const omitted =
  /^(?:body|text|content|payload|response|raw|data|bytes|buffer|message|messages|messageText|plainText|markdown|html|prompt|completion|input|output|args|params)$/i;
const windowMs = 30_000;
const maxEntries = 512;
// 固定轮询告警及成功的慢操作可汇总；失败仍立即输出。
const summaryEvents = new Set(['account-monitor:online-probe-failed']);
const volatileFields = new Set(['operationId', 'requestId', 'ts', 'timestamp']);
const slowIdentityFields = new Set([
  'scope',
  'event',
  'accountUin',
  'path',
  'type',
  'caller',
  'fingerprint',
]);

function isSuccessfulSlow(context: LoggerContext): boolean {
  return (
    context.outcome === 'ok' &&
    (context.event === 'request-slow' ||
      (context.scope === 'database' && context.event === 'database-slow'))
  );
}

interface PendingSummary {
  at: number;
  level: LogLevel;
  message: string;
  context: LoggerContext;
  summary: ConsoleSummary;
  affectedQueryCount: number;
  maxBlockedMs: number;
}

function updateSummary(entry: PendingSummary, context: LoggerContext): void {
  entry.context = context;
  entry.summary.count++;
  for (const key of ['affectedQueryCount', 'maxBlockedMs'] as const) {
    const value = context[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    if (key === 'affectedQueryCount') entry.affectedQueryCount += value;
    else entry.maxBlockedMs = Math.max(entry.maxBlockedMs, value);
  }
  for (const key of Object.keys(consoleTimingLabels) as Array<keyof typeof consoleTimingLabels>) {
    const value = context[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    const stats = entry.summary.timings[key];
    if (stats) {
      stats.count++;
      stats.min = Math.min(stats.min, value);
      stats.max = Math.max(stats.max, value);
      stats.total += value;
      stats.last = value;
    } else
      entry.summary.timings[key] = { count: 1, min: value, max: value, total: value, last: value };
  }
}

/** 忽略每次请求的关联与计时，保留错误、对象、调用位置和堆栈的差异。 */
function recordKey(level: LogLevel, message: string, context: LoggerContext, slow = false): string {
  const stable = Object.entries(context)
    .filter(([key]) =>
      slow
        ? slowIdentityFields.has(key)
        : !volatileFields.has(key) && !(key in consoleTimingLabels),
    )
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash('sha256')
    .update(JSON.stringify([level, message, stable]))
    .digest('hex');
}

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
  const color = (options.color ?? terminalColor('stderr', env)) && env.NO_COLOR === undefined;
  const pending = new Map<string, PendingSummary>();
  const stacks = new Map<string, number>();
  const details = minimum === 'debug';
  const output = (
    level: LogLevel,
    message: string,
    context: LoggerContext,
    extra: { stackRepeated?: boolean; summary?: ConsoleSummary } = {},
  ) => {
    try {
      sink(
        formatConsoleRecord(level, safeText(message), context, {
          now: now(),
          color: Boolean(color),
          details,
          ...extra,
        }),
      );
    } catch {
      // 终端断开或展示对象不可读不能影响业务。
    }
  };
  const outputSummary = (entry: PendingSummary) => {
    if (entry.summary.count > 1)
      output(
        entry.level,
        entry.message,
        {
          ...entry.context,
          affectedQueryCount: entry.affectedQueryCount,
          maxBlockedMs: entry.maxBlockedMs,
        },
        {
          summary: { ...entry.summary, windowMs: Math.max(0, now() - entry.at) },
        },
      );
  };
  const flush = () => {
    for (const entry of pending.values()) outputSummary(entry);
    pending.clear();
    stacks.clear();
  };
  const timer =
    enabled && !details
      ? setInterval(() => {
          for (const [key, entry] of pending) {
            if (now() - entry.at < windowMs) continue;
            outputSummary(entry);
            pending.delete(key);
          }
          for (const [key, at] of stacks) if (now() - at >= windowMs) stacks.delete(key);
        }, windowMs)
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
      const projected = projectConsoleContext(context) as LoggerContext;
      let stackRepeated = false;
      if (!details && (level === 'warn' || level === 'error')) {
        const nestedError = projected.error;
        const errorContext =
          nestedError && typeof nestedError === 'object'
            ? { ...nestedError, ...projected }
            : projected;
        const hasStack = typeof (errorContext.errorStack ?? errorContext.stack) === 'string';
        const slow = isSuccessfulSlow(context);
        const summarize =
          level === 'warn' && (slow || summaryEvents.has(`${context.scope}:${context.event}`));
        const key =
          hasStack || summarize
            ? recordKey(level, safeText(message), projected, summarize && slow)
            : '';
        if (summarize) {
          const old = pending.get(key);
          if (old && now() - old.at < windowMs) {
            updateSummary(old, projected);
            return;
          }
          if (old) outputSummary(old);
          pending.delete(key);
          if (pending.size >= maxEntries) {
            const first = pending.entries().next().value;
            if (first) {
              outputSummary(first[1]);
              pending.delete(first[0]);
            }
          }
          const entry: PendingSummary = {
            at: now(),
            level,
            message: safeText(message),
            context: projected,
            summary: { count: 0, windowMs: 0, timings: {} },
            affectedQueryCount: 0,
            maxBlockedMs: 0,
          };
          updateSummary(entry, projected);
          pending.set(key, entry);
        }
        if (hasStack) {
          const previous = stacks.get(key);
          stackRepeated = previous !== undefined && now() - previous < windowMs;
          if (!stackRepeated) {
            stacks.delete(key);
            if (stacks.size >= maxEntries) {
              const first = stacks.keys().next().value;
              if (first !== undefined) stacks.delete(first);
            }
            stacks.set(key, now());
          }
        }
      }
      output(level, message, projected, { stackRepeated });
    },
    dispose() {
      if (timer) clearInterval(timer);
      flush();
    },
    flush,
  };
}
