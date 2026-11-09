import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RETRYABLE_HTTP_STATUS,
  RetryableHttpError,
  isRetryableError,
  withRetry,
} from './retry.mjs';

/** 记录每次 sleep 的毫秒数，不真的等。 */
function fakeSleep() {
  const delays = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

test('成功时只调用一次，不触发重试', async () => {
  let calls = 0;
  const retries = [];
  const result = await withRetry(
    async () => {
      calls++;
      return 'ok';
    },
    { onRetry: (...args) => retries.push(args) },
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
  assert.deepEqual(retries, []);
});

test('可重试错误按指数退避重试，成功后返回', async () => {
  let calls = 0;
  const { delays, sleep } = fakeSleep();
  const retries = [];
  const result = await withRetry(
    async (attempt) => {
      calls++;
      if (attempt < 3) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return attempt;
    },
    {
      attempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      random: () => 0,
      sleep,
      onRetry: (error, attempt, attempts, delayMs) =>
        retries.push({ message: error.message, attempt, attempts, delayMs }),
    },
  );
  assert.equal(result, 3);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.deepEqual(retries, [
    { message: 'socket hang up', attempt: 1, attempts: 5, delayMs: 100 },
    { message: 'socket hang up', attempt: 2, attempts: 5, delayMs: 200 },
  ]);
});

test('退避有上限，并叠加抖动', async () => {
  const { delays, sleep } = fakeSleep();
  await assert.rejects(
    withRetry(
      async () => {
        throw new RetryableHttpError(503, 'Service Unavailable', 'https://example.test/x');
      },
      {
        attempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 150,
        random: () => 0.5,
        sleep,
      },
    ),
    (error) => {
      assert.equal(error.statusCode, 503);
      return true;
    },
  );
  // 100 + 50、150 + 50、150 + 50（第三次封顶后仍加抖动）
  assert.deepEqual(delays, [150, 200, 200]);
});

test('耗尽尝试次数后抛出最后一次错误', async () => {
  let calls = 0;
  const { sleep } = fakeSleep();
  const final = new Error('ETIMEDOUT');
  final.code = 'ETIMEDOUT';
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw final;
      },
      { attempts: 3, sleep, random: () => 0 },
    ),
    (error) => error === final,
  );
  assert.equal(calls, 3);
});

test('不可重试的错误直接抛出，不浪费重试', async () => {
  let calls = 0;
  const { delays, sleep } = fakeSleep();
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw new RetryableHttpError(404, 'Not Found', 'https://example.test/missing');
      },
      { attempts: 5, sleep, random: () => 0 },
    ),
    /HTTP 404 Not Found/,
  );
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('RetryableHttpError 携带状态码，可重试性由状态码决定', () => {
  const gateway = new RetryableHttpError(504, 'Gateway Time-out', 'https://example.test/x');
  assert.equal(gateway.statusCode, 504);
  assert.equal(gateway.retryable, true);
  assert.match(gateway.message, /504 Gateway Time-out/);
  assert.equal(isRetryableError(gateway), true);

  const missing = new RetryableHttpError(404, 'Not Found', 'https://example.test/x');
  assert.equal(missing.retryable, false);
  assert.equal(isRetryableError(missing), false);
});

test('可重试状态码覆盖网关 / 限流类，不含 404 / 403', () => {
  for (const code of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(RETRYABLE_HTTP_STATUS.has(code), true, `${code} 应该重试`);
  }
  for (const code of [400, 401, 403, 404, 422]) {
    assert.equal(RETRYABLE_HTTP_STATUS.has(code), false, `${code} 不该重试`);
  }
});

test('常见网络错误码与超时文案被判定为可重试', () => {
  for (const code of [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'ENOTFOUND',
    'UND_ERR_CONNECT_TIMEOUT',
  ]) {
    assert.equal(isRetryableError(Object.assign(new Error('boom'), { code })), true, code);
  }
  assert.equal(isRetryableError(new Error('请求超时（60s 无响应）')), true);
  assert.equal(isRetryableError(new Error('JSON 解析失败')), false);
  assert.equal(isRetryableError(undefined), false);
});

test('attempts 非法时立即报错', async () => {
  await assert.rejects(
    withRetry(async () => 'ok', { attempts: 0 }),
    RangeError,
  );
  await assert.rejects(
    withRetry(async () => 'ok', { attempts: 1.5 }),
    RangeError,
  );
});
