import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
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
