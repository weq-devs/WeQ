import { afterEach, expect, it, vi } from 'vitest';
import { logRequest, logTransportError } from '../src/common/request_log';
import { getLogger } from '../src/common/logger';
import { currentOperationId, withLogOperation } from '../src/common/operation_log';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  vi.spyOn(getLogger(), 'child').mockReturnValue(logger);
  return logger;
}
it('成功返回值不改变，嵌套请求继承关联 ID，结束后不残留', async () => {
  const logger = fixture();
  let id: string | undefined;
  const value = { ok: true };
  const result = await withLogOperation(() => {
    id = currentOperationId();
    return logRequest('trpc', 'message.page', 'query', async () => {
      expect(currentOperationId()).toBe(id);
      return value;
    });
  });
  expect(result).toBe(value);
  expect(id).toBeTruthy();
  expect(currentOperationId()).toBeUndefined();
  expect(logger.debug).toHaveBeenCalledWith('请求完成', expect.objectContaining({ outcome: 'ok' }));
});
it('慢 query 告警，订阅不按存活时间告警', async () => {
  const logger = fixture();
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  for (const type of ['query', 'subscription'])
    await logRequest('trpc', 'slow', type, async () => {
      time += 1500;
    });
  expect(logger.warn).toHaveBeenCalledTimes(1);
  expect(logger.debug).toHaveBeenCalledTimes(1);
});
it.each([
  ['bootstrap.openAccount', 'mutation', 2060, false],
  ['bootstrap.openAccount', 'mutation', 2999, false],
  ['bootstrap.openAccount', 'mutation', 3000, true],
  ['bootstrap.openAccount', 'mutation', 3500, true],
  ['bootstrap.openAccount', 'subscription', 3500, false],
  ['bootstrap.other', 'mutation', 1000, true],
  ['account.getUnreadInfos', 'query', 999, false],
  ['account.getUnreadInfos', 'query', 1000, true],
])('%s %s 耗时 %dms 的慢请求告警为 %s', async (path, type, durationMs, warns) => {
  const logger = fixture();
  let time = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => time);
  await logRequest('trpc', path, type, async () => {
    time += durationMs;
  });
  expect(logger.warn).toHaveBeenCalledTimes(warns ? 1 : 0);
  expect(logger.debug).toHaveBeenCalledTimes(warns ? 0 : 1);
  expect((warns ? logger.warn : logger.debug).mock.calls[0]![1]).toMatchObject({
    path,
    durationMs,
    event: warns ? 'request-slow' : 'request-complete',
  });
});
it('打开账号的失败不受慢请求阈值影响', async () => {
  const logger = fixture();
  await expect(
    logRequest('trpc', 'bootstrap.openAccount', 'mutation', async () => {
      throw new Error('open failed');
    }),
  ).rejects.toThrow('open failed');
  expect(logger.error).toHaveBeenCalledWith(
    '请求未完成',
    expect.objectContaining({ event: 'request-failed', outcome: 'failed' }),
  );
});
it('返回失败结果和抛出异常各记录一次，校验、未登录和取消为 debug', async () => {
  const logger = fixture();
  const error = new Error('failure');
  const value = { ok: false, error };
  expect(
    await logRequest(
      'trpc',
      'failed',
      'query',
      async () => value,
      (result) => result.error,
    ),
  ).toBe(value);
  const thrown = new Error('thrown');
  await expect(
    logRequest('trpc', 'throws', 'query', async () => {
      throw thrown;
    }),
  ).rejects.toBe(thrown);
  for (const failure of [
    { code: 'BAD_REQUEST' },
    { code: 'UNAUTHORIZED' },
    new DOMException('cancelled', 'AbortError'),
  ]) {
    await logRequest(
      'trpc',
      'expected',
      'query',
      async () => ({ error: failure }),
      (result) => result.error,
    );
  }
  expect(logger.error).toHaveBeenCalledTimes(2);
  expect(logger.debug).toHaveBeenCalledTimes(3);
});
it('HTTP/WS 适配器不重复打印已处理异常，传输层独有错误仍能看到', async () => {
  const logger = fixture();
  const error = new Error('handled');
  await logRequest(
    'trpc',
    'fixture',
    'query',
    async () => ({ error }),
    (result) => result.error,
  );
  logTransportError('trpc-http', 'fixture', error);
  logTransportError('trpc-ws', 'fixture', error);
  expect(logger.error).toHaveBeenCalledTimes(1);
  logTransportError('trpc-http', undefined, new Error('transport-only'));
  await Promise.resolve();
  expect(logger.error).toHaveBeenCalledTimes(2);
});
it('不同操作复用同一 Error 仍各记失败，抛出空值不误判成功', async () => {
  const logger = fixture();
  const error = new Error('shared');
  for (let i = 0; i < 2; i++)
    await expect(
      logRequest('trpc', 'fixture', 'query', async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  await expect(
    logRequest('trpc', 'fixture', 'query', async () => {
      throw null;
    }),
  ).rejects.toBeNull();
  expect(logger.error).toHaveBeenCalledTimes(3);
  expect(logger.error.mock.calls[2]![1]).toMatchObject({ outcome: 'failed', errorValue: 'null' });
});
