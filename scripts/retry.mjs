/**
 * 轻量重试助手：给「偶尔抖一下」的网络请求用。
 *
 * 背景：GitHub Releases 的下载链路由 `github.com/.../releases/download/...` 302 到
 * `release-assets.githubusercontent.com`，高峰期这条链路会间歇性返回 504，且失败是
 * 成片出现的（见 2026-11-09 的 CI：同一个 tag 连挂三次，本地复现单轮 10/10 失败）。
 * fetch-native 之前是「一次不成就退出」，一个 504 就能把整轮构建 / 发版打掉。
 *
 * 这里只负责「哪些错误值得再试」和「退避多久」，不关心 HTTP 细节；调用方把一次完整
 * 尝试包成 `operation` 即可。
 */

/** 值得重试的 HTTP 状态：超时 / 限流 / 网关类。4xx 里的鉴权、404 不重试。 */
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Node 网络层里典型的「再试一次可能就好」的错误码。 */
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** 把「HTTP 5xx」这种响应错误包成可被 isRetryableError 识别的异常。 */
export class RetryableHttpError extends Error {
  constructor(statusCode, statusMessage, url) {
    super(`HTTP ${statusCode}${statusMessage ? ` ${statusMessage}` : ''}${url ? `：${url}` : ''}`);
    this.name = 'RetryableHttpError';
    this.statusCode = statusCode;
    this.retryable = RETRYABLE_HTTP_STATUS.has(statusCode);
  }
}

export function isRetryableError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.retryable === true) return true;
  const code = typeof error.code === 'string' ? error.code : '';
  if (RETRYABLE_NET_CODES.has(code)) return true;
  const message = typeof error.message === 'string' ? error.message : '';
  return /socket hang up|timed out|timeout|premature close|aborted|超时|无响应/i.test(message);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 执行 `operation`，失败且可重试时按指数退避（带抖动）再试。
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation 一次完整尝试。
 * @param {object} [options]
 * @param {number} [options.attempts=6] 总尝试次数（含第一次）。
 * @param {number} [options.baseDelayMs=2000] 首次退避基数，之后翻倍。
 * @param {number} [options.maxDelayMs=30000] 单次退避上限。
 * @param {(error: unknown, attempt: number, attempts: number, delayMs: number) => void} [options.onRetry]
 *   每次决定重试时回调，用于打日志 / 换行收进度条。
 * @param {(ms: number) => Promise<void>} [options.sleep] 测试可注入。
 * @param {() => number} [options.random] 测试可注入抖动源。
 * @returns {Promise<T>}
 */
export async function withRetry(
  operation,
  {
    attempts = 8,
    baseDelayMs = 2000,
    maxDelayMs = 30_000,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = {},
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`attempts 必须是正整数，收到 ${attempts}`);
  }
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === attempts) break;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = backoff + Math.floor(random() * baseDelayMs);
      onRetry?.(error, attempt, attempts, delayMs);
      await sleep(delayMs);
    }
  }
  throw lastError;
}
