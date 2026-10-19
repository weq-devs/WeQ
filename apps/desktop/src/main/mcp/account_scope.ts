import { AsyncLocalStorage } from 'node:async_hooks';

type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<unknown>;

const accountScope = new AsyncLocalStorage<() => void>();
const closedAccounts = new WeakSet<object>();

export function invalidateAccountTools(account: object | null): void {
  if (account) closedAccounts.add(account);
}

export function assertAccountToolScope(): void {
  accountScope.getStore()?.();
}

/** Nested sandbox calls inherit the originating account, including after awaits. */
export function bindAccountTools(
  account: object,
  currentAccount: () => object | null,
  run: ToolRunner,
): ToolRunner {
  const check = (): void => {
    if (closedAccounts.has(account) || currentAccount() !== account)
      throw new Error('助手任务所属账号已关闭或切换。');
  };
  return (name, args) =>
    accountScope.run(check, async () => {
      check();
      const result = await run(name, args);
      check();
      return result;
    });
}
