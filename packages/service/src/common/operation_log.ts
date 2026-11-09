import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const operations = new AsyncLocalStorage<string>();
export const currentOperationId = () => operations.getStore();
export function withLogOperation<T>(run: () => T): T {
  return operations.getStore() ? run() : operations.run(randomUUID(), run);
}
