import { getLogger, logErrorContext } from './logger';
import { withLogOperation, currentOperationId } from './operation_log';
import { beginRequestMetric } from '../performance/requests';

const expected = new Set([
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CLIENT_CLOSED_REQUEST',
]);
const reported = new WeakMap<object, string>();
function wasReported(error: unknown, operationId?: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const matches = (object: object) =>
    operationId ? reported.get(object) === operationId : reported.has(object);
  return (
    matches(error) ||
    ('cause' in error && !!error.cause && typeof error.cause === 'object' && matches(error.cause))
  );
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
      const cancelled =
        detail?.name === 'AbortError' ||
        (detail?.cause instanceof Error && detail.cause.name === 'AbortError') ||
        detail?.code === 'CLIENT_CLOSED_REQUEST';
      const level = failed
        ? cancelled || expected.has(detail?.code ?? '')
          ? 'debug'
          : 'error'
        : durationMs >= 1000 && (type === 'query' || type === 'mutation')
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
