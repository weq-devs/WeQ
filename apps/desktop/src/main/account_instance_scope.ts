/** 桌面层接管账号进程所有权。独立 Web 仍使用自己的单账号生命周期。 */
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
