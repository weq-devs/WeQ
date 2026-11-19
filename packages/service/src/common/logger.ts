import { mkdirSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { EOL } from 'node:os';
import { join } from 'node:path';
import { createConsoleLogger, type ConsoleLoggerOptions } from './console_logger';
import { LogFileWriter } from './log_file_writer';
import { isWeqLogName, utcLogDay } from './log_files';
import { currentOperationId } from './operation_log';
import { RequestLogBatch } from './request_log_batch';

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

let writer: LogFileWriter | undefined;
let rolloverTimer: ReturnType<typeof setInterval> | undefined;
let requestDetails = false;
const requestBatch = new RequestLogBatch((summary) => {
  if (!writer) return;
  writeRecord(writer, new Date().toISOString(), 'debug', '请求完成汇总', {
    ...summary,
    event: 'request-complete-summary',
  });
});
let terminal: ReturnType<typeof createConsoleLogger> | undefined;
export function configureConsoleLogger(options: ConsoleLoggerOptions): void {
  terminal?.dispose();
  terminal = createConsoleLogger(options);
}
export function flushConsoleLogger(): void {
  terminal?.flush();
}
export async function flushFileLogger(): Promise<void> {
  requestBatch.flush(Date.now());
  await writer?.flush();
}
process.once('exit', () => {
  flushConsoleLogger();
  writer?.prepareExit();
  requestBatch.flush(Date.now());
  writer?.flushOnExit();
});

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

function writeRecord(
  target: LogFileWriter,
  ts: string,
  level: LogLevel,
  message: string,
  context?: LoggerContext,
): void {
  try {
    const normalized = normalizeContext(context);
    const line = JSON.stringify({
      ts,
      level,
      message,
      ...(normalized ? { context: normalized } : {}),
    });
    target.record(
      line + EOL,
      ts.slice(0, 10),
      level === 'warn' || level === 'error' || context?.event === 'request-failed',
    );
  } catch {
    // 日志序列化失败不影响业务。
  }
}

function write(level: LogLevel, message: string, context?: LoggerContext): void {
  const operationId = currentOperationId();
  if (operationId) context = { operationId, ...context };
  try {
    terminal?.write(level, message, context);
  } catch {
    /* 日志展示失败不影响落盘。 */
  }
  const target = writer;
  if (!target) return;
  const now = new Date();
  const emit = () => writeRecord(target, now.toISOString(), level, message, context);
  if (
    !requestDetails &&
    level === 'debug' &&
    context?.event === 'request-complete' &&
    context.outcome === 'ok' &&
    (context.scope === 'mcp-server' || context.scope === 'trpc') &&
    typeof context.path === 'string' &&
    typeof context.type === 'string' &&
    typeof context.durationMs === 'number' &&
    context.durationMs >= 0 &&
    context.durationMs < 1000
  ) {
    const { scope, path, type, durationMs } = context;
    requestBatch.record({ scope, path, type, durationMs }, emit, now.getTime());
  } else {
    emit();
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
  const dir = join(baseDir, 'logs');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    rootLogger.warn('日志目录暂不可用，终端输出继续工作', {
      scope: 'logger',
      event: 'log-directory-unavailable',
      logDir: dir,
      ...logErrorContext(error),
    });
    return rootLogger;
  }
  if (writer?.dir !== dir) {
    void flushFileLogger();
    writer = new LogFileWriter(dir);
    requestDetails = process.env.WEQ_LOG_REQUEST_DETAILS === '1';
    if (!rolloverTimer) rolloverTimer = setInterval(() => void writer?.flush(), 60_000).unref();
  }
  rootLogger.info('logger initialized', { scope: 'logger', event: 'init', logDir: dir });
  return rootLogger;
}

export function getLogger(): Logger {
  return rootLogger;
}

export function getLogDir(): string | null {
  return writer?.dir ?? null;
}

export function getActiveLogPath(): string | null {
  return writer?.activePath ?? null;
}

export function archiveHistoricalLogs(): void {
  writer?.archiveHistorical();
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
// WeQ 的明文分段、历史 gzip 和原生日志都优先按文件名日期清理，不受复制/触碰的影响。
// 没有日期的日志退回用修改时间。

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
  const days = Math.floor(retentionDays) - 1;
  const cutoff = shiftedDateKey(now, -days);
  const weqCutoff = utcLogDay(new Date(now.getTime() - days * 86_400_000));
  const expired: string[] = [];
  for (const file of files) {
    const key = dateKeyInName(file.name) ?? localDateKey(new Date(file.mtimeMs));
    if (key < (isWeqLogName(file.name) ? weqCutoff : cutoff)) expired.push(file.name);
  }
  return expired;
}

/**
 * 清理 `dir` 下过期的 `.log` / `.log.gz`，返回被删掉的文件名。
 *
 * 目录不存在 / 读不到就静默返回空——清理只是顺手做的家务，绝不能让读日志
 * （或启动）失败。单个文件删不掉（被占用等）也只跳过它，不影响其它文件。
 */
export function pruneExpiredLogs(
  dir: string,
  retentionDays: number,
  now: Date = new Date(),
): string[] {
  if (!dir || retentionDays <= 0) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const files: LogFileCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.log') && !name.endsWith('.log.gz')) continue;
    const path = join(dir, name);
    if (path === getActiveLogPath()) continue;
    try {
      const st = lstatSync(path);
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
