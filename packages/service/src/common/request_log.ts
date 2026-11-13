import { getLogger, logErrorContext } from './logger';
import { withLogOperation, currentOperationId } from './operation_log';
import { beginRequestMetric } from '../performance/requests';
import { OperationError } from './operation_error';

const expected = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CLIENT_CLOSED_REQUEST',
  'PRECONDITION_FAILED',
  'CONFLICT',
]);
function* errorChain(error: unknown): Generator<object> {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current) && seen.size < 16) {
    seen.add(current);
    yield current;
    current = 'cause' in current ? current.cause : undefined;
  }
}
function failurePolicy(
  error: unknown,
  type: string,
): { level: 'debug' | 'warn' | 'error'; cancelled: boolean } {
  let policy: { level: 'debug' | 'warn' | 'error'; cancelled: boolean } | undefined;
  for (const current of errorChain(error)) {
    // 编程错误即便带有预期失败的 cause，也不能因此降级。
    if (
      current instanceof TypeError ||
      current instanceof RangeError ||
      current instanceof ReferenceError ||
      current instanceof SyntaxError
    )
      return { level: 'error', cancelled: false };
    // 首个带语义的错误决定性质：底层 abort 可能是超时实现，不能推翻外层超时/解码结论。
    // 仍继续遍历，以免显式业务分类隐藏更深层的编程错误。
    if (policy) continue;
    if (current instanceof OperationError) {
      const { diagnostic } = current;
      policy = {
        level:
          diagnostic === 'cancelled' || diagnostic === 'expected'
            ? 'debug'
            : diagnostic === 'unavailable' || (diagnostic === 'read-failure' && type === 'query')
              ? 'warn'
              : 'error',
        cancelled: diagnostic === 'cancelled',
      };
      continue;
    }
    const detail = current as { code?: string; name?: string; cause?: unknown };
    if (detail.name === 'AbortError' || detail.code === 'CLIENT_CLOSED_REQUEST')
      policy = { level: 'debug', cancelled: true };
    if (expected.has(detail.code ?? '')) policy ??= { level: 'debug', cancelled: false };
    if (detail.code === 'QQ_ONLINE_PROBE_TIMEOUT' || detail.code === 'REMOTE_REJECTED')
      policy ??= { level: 'warn', cancelled: false };
  }
  return policy ?? { level: 'error', cancelled: false };
}
const reported = new WeakMap<object, string>();
function wasReported(error: unknown, operationId?: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const matches = (object: object) =>
    operationId ? reported.get(object) === operationId : reported.has(object);
  return [...errorChain(error)].some(matches);
}
export function logTransportError(scope: string, path: string | undefined, error: unknown): void {
  if (wasReported(error)) return;
  void logRequest(
    scope,
    path ?? '<unknown>',
    'transport',
    async () => ({ error }),
    (result) => result.error,
  );
}
export async function logRequest<T>(
  scope: string,
  path: string,
  type: string,
  run: () => Promise<T>,
  resultError: (result: T) => unknown = () => undefined,
): Promise<T> {
  return withLogOperation(async () => {
    const finishMetric = beginRequestMetric(path);
    const began = performance.now();
    const logger = getLogger().child({ scope });
    const record = (error?: unknown, failed = error !== undefined) => {
      const durationMs = Math.round(performance.now() - began);
      const detail =
        error && typeof error === 'object'
          ? (error as { code?: string; name?: string; cause?: unknown })
          : undefined;
      const policy = failurePolicy(error, type);
      const cancelled = policy.cancelled;
      const slowThresholdMs = path === 'bootstrap.openAccount' ? 3000 : 1000;
      const level = failed
        ? policy.level
        : durationMs >= slowThresholdMs && (type === 'query' || type === 'mutation')
          ? 'warn'
          : 'debug';
      const operationId = currentOperationId();
      const alreadyReported = wasReported(error, operationId);
      if (error && typeof error === 'object' && operationId) reported.set(error, operationId);
      logger[alreadyReported ? 'debug' : level](failed ? '请求未完成' : '请求完成', {
        event: failed ? 'request-failed' : level === 'warn' ? 'request-slow' : 'request-complete',
        path,
        type,
        durationMs,
        outcome: cancelled ? 'cancelled' : failed ? 'failed' : 'ok',
        code: detail?.code,
        ...(failed && !alreadyReported ? logErrorContext(error) : {}),
      });
    };
    try {
      const result = await run();
      const error = resultError(result);
      finishMetric(error !== undefined);
      record(error);
      return result;
    } catch (error) {
      finishMetric(true);
      record(error, true);
      throw error;
    }
  });
}
