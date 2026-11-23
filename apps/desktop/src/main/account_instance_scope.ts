/** 桌面与独立 Web 共用 QQ 号的进程所有权。 */
export interface AccountInstanceScope {
  run<T>(
    uin: string | null,
    operation: () => Promise<T>,
    opened: () => string | undefined,
  ): Promise<T>;
}

let scope: AccountInstanceScope | undefined;

export function setAccountInstanceScope(next: AccountInstanceScope): void {
  scope = next;
}

export function withAccountInstance<T>(
  uin: string | null,
  operation: () => Promise<T>,
  opened: () => string | undefined,
): Promise<T> {
  return scope ? scope.run(uin, operation, opened) : operation();
}
