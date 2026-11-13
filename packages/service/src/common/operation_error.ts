export type OperationDiagnostic = 'expected' | 'cancelled' | 'unavailable' | 'read-failure';

/** 仅描述日志性质；不修改请求返回值、重试策略或传输层错误码。 */
export class OperationError extends Error {
  constructor(
    message: string,
    readonly diagnostic: OperationDiagnostic | undefined,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OperationError';
  }
}
