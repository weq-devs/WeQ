import { createHmac, randomBytes } from 'node:crypto';
import type { RuntimeLogger } from '@weq/agentlab';

export interface BotLoggingConfig {
  /** 显式带时区的 ISO 截止时间；最多开启 30 分钟，重启不会延长。 */
  debugContentUntil?: string;
}
export const BOT_CONTENT_DEBUG_MAX_MS = 30 * 60 * 1000;
export const BOT_CONTENT_LOG_LIMIT = 512;
const time = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const numbers = new Set([
  'textLen',
  'bytes',
  'turnCount',
  'elapsedMs',
  'queued',
  'score',
  'retryDelayMs',
  'port',
  'refClipCount',
  'httpStatus',
  'debugUntilMs',
]);
const booleans = new Set(['hasTts', 'hasVoiceBinding', 'mentionsSelf']);
const enums: Record<string, ReadonlySet<string>> = {
  chatType: new Set(['private', 'group']),
  status: new Set(['received', 'generated', 'sent', 'silent', 'reply', 'failed']),
  errorType: new Set(['timeout', 'cancelled', 'http', 'other']),
  adapter: new Set(['napcat', 'snowluma']),
  mode: new Set(['clone', 'preset']),
};
type Context = Record<string, unknown>;
type ContentEvent = 'incoming' | 'generated' | 'sent' | 'group-decision' | 'error-detail';
interface State {
  key: Buffer;
  debugUntil: number;
  monotonicUntil: number;
}

export function botErrorMetadata(error: unknown): Context {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
    return { errorType: 'http', httpStatus: status };
  return {
    errorType:
      error instanceof Error && error.name === 'TimeoutError'
        ? 'timeout'
        : error instanceof Error && error.name === 'AbortError'
          ? 'cancelled'
          : 'other',
  };
}

/** 默认只接受元数据白名单；正文、自由文本错误及供应商返回只走显式短期调试。 */
export class BotLogger implements RuntimeLogger {
  private constructor(
    private readonly state: State,
    private readonly context: Context = {},
  ) {}

  static create(config: BotLoggingConfig = {}): BotLogger {
    const now = Date.now();
    const monotonicStart = performance.now();
    let debugUntil = 0;
    if (config.debugContentUntil !== undefined) {
      const value = config.debugContentUntil;
      if (
        typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      )
        throw new Error('正文调试截止时间必须是带时区的 ISO 时间');
      debugUntil = Date.parse(value);
      if (!Number.isFinite(debugUntil) || debugUntil - now > BOT_CONTENT_DEBUG_MAX_MS)
        throw new Error('正文调试截止时间无效或超过 30 分钟');
    }
    const logger = new BotLogger({
      key: randomBytes(32),
      debugUntil,
      monotonicUntil: monotonicStart + Math.max(0, debugUntil - now),
    });
    if (logger.debugEnabled)
      logger.warn('正文调试已开启，日志可能包含私聊内容；到期自动关闭，请勿分享调试日志', {
        debugUntilMs: debugUntil,
      });
    return logger;
  }

  get debugEnabled(): boolean {
    if (Date.now() >= this.state.debugUntil || performance.now() >= this.state.monotonicUntil) {
      this.disableContent();
      return false;
    }
    return true;
  }
  disableContent(): void {
    this.state.debugUntil = 0;
    this.state.monotonicUntil = 0;
  }
  ref(kind: string, value: string): string {
    return createHmac('sha256', this.state.key)
      .update(JSON.stringify([kind, value]))
      .digest('hex')
      .slice(0, 12);
  }
  child(context: Context): BotLogger {
    return new BotLogger(this.state, { ...this.context, ...context });
  }
  info(message: string, context?: Context): void {
    this.write('info', message, context);
  }
  warn(message: string, context?: Context): void {
    this.write('warn', message, context);
  }
  error(message: string, context?: Context): void {
    this.write('error', message, context);
  }
  content(event: ContentEvent, text: string, context?: Context): void {
    if (this.debugEnabled)
      this.write('info', `正文调试:${event}`, context, text.slice(0, BOT_CONTENT_LOG_LIMIT));
  }
  errorDetail(error: unknown): void {
    if (error instanceof Error) this.content('error-detail', error.message);
  }

  private write(
    level: 'info' | 'warn' | 'error',
    message: string,
    context: Context = {},
    text?: string,
  ): void {
    try {
      const safe: Context = {};
      const merged = { ...this.context, ...context };
      for (const [key, value] of Object.entries(merged)) {
        if (numbers.has(key) && typeof value === 'number' && Number.isFinite(value))
          safe[key] = value;
        else if (booleans.has(key) && typeof value === 'boolean') safe[key] = value;
        else if (
          typeof value === 'string' &&
          ((Object.hasOwn(enums, key) && enums[key]!.has(value)) ||
            (key === 'peerRef' && /^[0-9a-f]{12}$/.test(value)))
        )
          safe[key] = value;
      }
      const detail =
        this.debugEnabled && typeof merged.errorMessage === 'string'
          ? merged.errorMessage.slice(0, BOT_CONTENT_LOG_LIMIT)
          : undefined;
      const line = JSON.stringify({
        ts: `${time.format(new Date())}+08:00`,
        level,
        message,
        ...safe,
        ...(text === undefined ? {} : { text }),
        ...(detail === undefined ? {} : { detail }),
      });
      if (level === 'info') console.log(line);
      else if (level === 'warn') console.warn(line);
      else console.error(line);
    } catch {
      /* 日志失败不能改变已经发生的生成或发送结果。 */
    }
  }
}
