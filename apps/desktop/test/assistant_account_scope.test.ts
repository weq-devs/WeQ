import { expect, it, vi } from 'vitest';
import {
  assertAccountToolScope,
  bindAccountTools,
  invalidateAccountTools,
} from '../src/main/mcp/account_scope';
import { activeAssistantRuns, cancelAssistantRuns } from '../src/main/mcp/assistant_bus';
import { runJsSandbox } from '../src/main/mcp/js_sandbox';

it('binds tool execution to the original session, not merely the same UIN', async () => {
  const first = { uin: '123' };
  let current: object | null = first;
  const execute = vi.fn(async () => 'original-account-data');
  const run = bindAccountTools(first, () => current, execute);
  expect(await run('read', {})).toBe('original-account-data');
  current = { uin: '123' };
  await expect(run('read', {})).rejects.toThrow('账号已关闭或切换');
  expect(execute).toHaveBeenCalledTimes(1);
  current = null;
  await expect(run('send', {})).rejects.toThrow('账号已关闭或切换');
});

it('guards service lookups after awaits and refuses stale results', async () => {
  const account = {};
  let current: object | null = account;
  const access = vi.fn();
  const run = bindAccountTools(
    account,
    () => current,
    async () => {
      await Promise.resolve();
      current = {};
      assertAccountToolScope();
      access();
    },
  );
  await expect(run('read', {})).rejects.toThrow('账号已关闭或切换');
  expect(access).not.toHaveBeenCalled();
  current = account;
  const stale = bindAccountTools(
    account,
    () => current,
    async () => {
      current = {};
      return 'stale';
    },
  );
  await expect(stale('read', {})).rejects.toThrow('账号已关闭或切换');
});

it('carries the account guard through sandbox worker callbacks', async () => {
  const account = {};
  let current: object | null = account;
  const access = vi.fn();
  const run = bindAccountTools(
    account,
    () => current,
    async () => {
      const result = await runJsSandbox('return await callTool("read", {});', async () => {
        current = {};
        assertAccountToolScope();
        access();
      });
      current = account;
      return result;
    },
  );
  const result = (await run('run_js', {})) as { ok: boolean; error: string };
  expect(result.ok).toBe(false);
  expect(result.error).toContain('账号已关闭或切换');
  expect(access).not.toHaveBeenCalled();
});

it('account teardown aborts every active assistant run', () => {
  const first = new AbortController();
  const second = new AbortController();
  activeAssistantRuns.set('first', first);
  activeAssistantRuns.set('second', second);
  cancelAssistantRuns();
  expect(first.signal.aborted).toBe(true);
  expect(second.signal.aborted).toBe(true);
  expect(activeAssistantRuns.size).toBe(0);
});

it('invalidates the session before asynchronous account disposal finishes', async () => {
  const account = {};
  const execute = vi.fn(async () => 'data');
  const run = bindAccountTools(account, () => account, execute);
  invalidateAccountTools(account);
  await expect(run('read', {})).rejects.toThrow('账号已关闭或切换');
  expect(execute).not.toHaveBeenCalled();
});
