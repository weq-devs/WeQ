/** 桌面与独立 Web 共用 QQ 号的进程所有权。 */
export interface AccountInstanceScope {
  run<T>(
    uin: string | null,
    operation: () => Promise<T>,
    opened: () => string | undefined,
  ): Promise<T>;
}

const state = accountRuntimeState(() => ({ scope: undefined as AccountInstanceScope | undefined }));

export function setAccountInstanceScope(next: AccountInstanceScope): void {
  state().scope = next;
}

export function withAccountInstance<T>(
  uin: string | null,
  operation: () => Promise<T>,
  opened: () => string | undefined,
): Promise<T> {
  const { scope } = state();
  return scope ? scope.run(uin, operation, opened) : operation();
}
import { accountRuntimeState } from './context/account_runtime';
