// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { JS_SANDBOX_MAX_ARGUMENT_CHARS, runJsSandbox } from '../src/main/mcp/js_sandbox';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.each(['callTool', 'sleep', 'console.log', '(await callTool("read", {}))'])(
  'keeps the %s prototype chain inside the interpreter',
  async (value) => {
    const run = vi.fn(async () => ({ nested: { value: 1 } }));
    const result = await runJsSandbox(
      `const value = ${value}; return value.constructor.constructor('return typeof process + ":" + typeof require')();`,
      run,
    );
    expect(result.ok).toBe(true);
    expect(result.result).toBe('undefined:undefined');
  },
);

it('supports asynchronous aggregation without exposing host globals', async () => {
  const result = await runJsSandbox(
    'await sleep(1); console.log("query"); const rows = await callTool("read", {}); return rows.map(x => x * 2);',
    async () => [1, 2, 3],
  );
  expect(result.ok).toBe(true);
  expect(result.result).toEqual([2, 4, 6]);
  expect(result.logs.join(' ')).toContain('query');
  expect(result.calls).toEqual([expect.objectContaining({ name: 'read', ok: true })]);
});

it('interrupts loops after an await as well as synchronous loops', async () => {
  const result = await runJsSandbox('await sleep(1); while (true) {}', async () => null, 1000);
  expect(result.ok).toBe(false);
  expect(result.ms).toBeLessThan(4000);
}, 6000);

it('does not treat fire-and-forget calls as a completed script', async () => {
  const result = await runJsSandbox('callTool("read", {}); return 1;', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return 2;
  });
  expect(result.ok).toBe(false);
  expect(result.unawaited).toBeGreaterThan(0);
});

it('only explicit unrestricted execution can remove a synthetic external file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-permission-'));
  const outside = join(root, 'external-synthetic.txt');
  writeFileSync(outside, 'synthetic');
  const code = `require('node:fs').rmSync(${JSON.stringify(outside)}); return 'removed';`;
  try {
    const sandbox = await runJsSandbox(code, async () => null);
    expect(sandbox.ok).toBe(false);
    expect(existsSync(outside)).toBe(true);
    const unrestricted = await runJsSandbox(code, async () => null, 1000, {
      permissionMode: 'unrestricted',
    });
    expect(unrestricted.ok).toBe(true);
    expect(existsSync(outside)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  { name: 'search_messages', state: 'interrupted' },
  { name: 'delayed', state: 'unknown' },
])('propagates cancellation and preserves the $state result of $name', async (entry) => {
  let complete!: () => void;
  let aborted = false;
  const result = await runJsSandbox(
    `return await callTool(${JSON.stringify(entry.name)}, {});`,
    async (_name, _args, signal) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
      });
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      return 'completed-later';
    },
    1000,
  );
  expect(result.ok).toBe(false);
  expect(aborted).toBe(true);
  expect(result.calls[0]?.state).toBe(entry.state);
  if (entry.state === 'unknown') expect(result.notes?.join(' ')).toContain('不要自动重试');
  else expect(result.notes).toBeUndefined();
  complete();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(result.calls[0]?.state).toBe(entry.state);
});

it.each([
  `return await callTool('read', { payload: 'x'.repeat(${JS_SANDBOX_MAX_ARGUMENT_CHARS + 1}) });`,
  "return await callTool('x'.repeat(10000), {});",
  "return await __call('read', '[]');",
])('rejects invalid or oversized RPC input before reaching a host tool', async (code) => {
  const run = vi.fn(async () => null);
  const result = await runJsSandbox(code, run);
  expect(result.ok).toBe(false);
  expect(run).not.toHaveBeenCalled();
});
