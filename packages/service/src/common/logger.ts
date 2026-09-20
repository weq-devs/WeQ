import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { EOL } from 'node:os';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LoggerContext {
  scope?: string;
  accountUin?: string | null;
  event?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LoggerContext): void;
  info(message: string, context?: LoggerContext): void;
  warn(message: string, context?: LoggerContext): void;
  error(message: string, context?: LoggerContext): void;
  child(defaultContext: LoggerContext): Logger;
}

const state = {
  baseDir: null as string | null,
};

function timestamp(): string {
  return new Date().toISOString();
}

function dayKey(): string {
  return timestamp().slice(0, 10);
}

function normalizeContext(context: LoggerContext | undefined): Record<string, unknown> | undefined {
  if (!context) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined) continue;
    if (value instanceof Error) {
      out[key] = {
        name: value.name,
        message: value.message,
        stack: value.stack,
      };
      continue;
    }
    if (typeof value === 'bigint') {
      out[key] = value.toString();
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function filePath(): string | null {
  if (!state.baseDir) return null;
  const dir = join(state.baseDir, 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${dayKey()}.log`);
}

function write(level: LogLevel, message: string, context?: LoggerContext): void {
  const target = filePath();
  if (!target) return;
  const line = JSON.stringify({
    ts: timestamp(),
    level,
    message,
    ...(normalizeContext(context) ? { context: normalizeContext(context) } : {}),
  });
  try {
    appendFileSync(target, line + EOL, 'utf-8');
  } catch {
    // Logging must never break the app flow.
  }
}

class FileLogger implements Logger {
  constructor(private readonly defaultContext: LoggerContext = {}) {}

  debug(message: string, context?: LoggerContext): void {
    write('debug', message, { ...this.defaultContext, ...context });
  }

  info(message: string, context?: LoggerContext): void {
    write('info', message, { ...this.defaultContext, ...context });
  }

  warn(message: string, context?: LoggerContext): void {
    write('warn', message, { ...this.defaultContext, ...context });
  }

  error(message: string, context?: LoggerContext): void {
    write('error', message, { ...this.defaultContext, ...context });
  }

  child(defaultContext: LoggerContext): Logger {
    return new FileLogger({ ...this.defaultContext, ...defaultContext });
  }
}

const rootLogger = new FileLogger();

export function initLogger(baseDir: string): Logger {
  state.baseDir = baseDir;
  const dir = join(baseDir, 'logs');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  rootLogger.info('logger initialized', { scope: 'logger', event: 'init', logDir: dir });
  return rootLogger;
}

export function getLogger(): Logger {
  return rootLogger;
}

export function getLogDir(): string | null {
  return state.baseDir ? join(state.baseDir, 'logs') : null;
}

export function logErrorContext(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      errorStack: error.stack,
    };
  }
  return { errorValue: String(error) };
}

// ── 日志保留清理 ─────────────────────────────────────────────────────────────
//
// 日志按天拆成 `<YYYY-MM-DD>.log`（原生日志是 `nt_helper_<date>.log` /
// `native_loader_<date>.log`），所以「过期」可以直接按**文件名里的日期**判断——
// 不用 stat 每个文件的年龄，也不怕日志文件被 touch / 拷来拷去改了 mtime。
// 没有日期的 `.log` 退回用修改时间。

/** 文件名里的 `YYYY-MM-DD`（取第一个像日期的段），取不到返回 null。 */
function dateKeyInName(name: string): string | null {
  const m = /(20\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 本地时区的 `YYYY-MM-DD`。 */
function localDateKey(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** 相对 `date` 偏移 `days` 天的本地日期键（跨月/跨年由 Date 处理）。 */
function shiftedDateKey(date: Date, days: number): string {
  return localDateKey(new Date(date.getFullYear(), date.getMonth(), date.getDate() + days));
}

/** 一个候选日志文件：文件名 + 修改时间（判断日期用）。 */
export interface LogFileCandidate {
  name: string;
  mtimeMs: number;
}

/**
 * 挑出应当删除的日志文件名（纯函数，便于单测）。
 *
 * 保留「最近 `retentionDays` 天（含今天）」：今天往前第 `retentionDays - 1` 天之前
 * 的文件才算过期。`retentionDays <= 0` 表示永久保留，直接不删任何东西；今天的日志
 * 永远保留（哪怕 retentionDays = 1）。
 */
export function planExpiredLogs(
  files: ReadonlyArray<LogFileCandidate>,
  retentionDays: number,
  now: Date = new Date(),
): string[] {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return [];
  const cutoff = shiftedDateKey(now, -(Math.floor(retentionDays) - 1));
  const expired: string[] = [];
  for (const file of files) {
    const key = dateKeyInName(file.name) ?? localDateKey(new Date(file.mtimeMs));
    if (key < cutoff) expired.push(file.name);
  }
  return expired;
}

/**
 * 清理 `dir` 下过期的 `.log`，返回被删掉的文件名。
 *
 * 目录不存在 / 读不到就静默返回空——清理只是顺手做的家务，绝不能让读日志
 * （或启动）失败。单个文件删不掉（被占用等）也只跳过它，不影响其它文件。
 */
export function pruneExpiredLogs(
  dir: string,
  retentionDays: number,
  now: Date = new Date(),
): string[] {
  if (!dir || retentionDays <= 0 || !existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: LogFileCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    try {
      const st = statSync(join(dir, name));
      if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs });
    } catch {
      // 读不到元信息的跳过，下次再试
    }
  }
  const removed: string[] = [];
  for (const name of planExpiredLogs(files, retentionDays, now)) {
    try {
      rmSync(join(dir, name), { force: true });
      removed.push(name);
    } catch {
      // 删不掉就留给下一轮
    }
  }
  return removed;
}
