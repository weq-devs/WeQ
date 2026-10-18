// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createQQKernelProcessBackend,
  type QQKernelProcessBackend,
} from '../src/main/qq_runtime/process_backend';
import type { QQRuntimeBackendEvent } from '@weq/service';

const directories: string[] = [],
  backends: QQKernelProcessBackend[] = [];
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture(hostName = 'fixture') {
  const root = await mkdtemp(join(tmpdir(), 'weq-runtime-ipc-'));
  directories.push(root);
  const options = {
    instanceId: randomUUID(),
    nonce: randomBytes(24).toString('hex'),
    wrapperPath: '/fixture/wrapper.node',
    dataRoot: join(root, 'new-data'),
    expectedUin: '10001',
    client: { appId: '12345', version: 'fixture', qua: 'fixture' },
    device: { hostName, osVersion: 'fixture' },
  };
  const backend = await createQQKernelProcessBackend(
    options,
    fileURLToPath(new URL('./fixtures/qq_runtime_child.cjs', import.meta.url)),
  );
  backends.push(backend);
  const events: QQRuntimeBackendEvent[] = [];
  backend.subscribe((event) => events.push(event));
  return { backend, events, options };
}

describe('独立进程监督（仅本地测试子进程）', () => {
  it('不继承父进程的调试或内联脚本参数', async () => {
    const original = [...process.execArgv];
    try {
      process.execArgv.push('--input-type=module');
      const f = await fixture('reject-parent-flags');
      await f.backend.initialize(new AbortController().signal);
      await f.backend.close();
      expect(f.events.at(-1)).toMatchObject({ type: 'exit', code: 0 });
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...original);
    }
  });
  it('绑定真实 PID/实例，忽略旧帧，内核就绪不冒充业务能力', async () => {
    const f = await fixture();
    expect(f.backend.pid).toBeGreaterThan(0);
    await f.backend.initialize(new AbortController().signal);
    expect(f.events.filter((event) => event.type === 'observation')).toHaveLength(1);
    await f.backend.login('10001');
    await vi.waitFor(() =>
      expect(
        f.events.some(
          (event) => event.type === 'observation' && event.value.account?.uid === 'u_fixture',
        ),
      ).toBe(true),
    );
    for (const event of f.events)
      if (event.type === 'observation') {
        expect(event.value.capabilities.sso).toBe(false);
        expect(event.value.capabilities.database).toBe(false);
      }
    expect(JSON.stringify(f.events)).not.toContain(f.options.nonce);
    expect(JSON.stringify(f.events)).not.toContain('not-forwarded');
    await f.backend.health();
    await f.backend.close();
    expect(f.events.at(-1)).toMatchObject({ type: 'exit', code: 0 });
  });

  it('启动前取消不会发起登录，也不等待固定超时才退出', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.backend.initialize(controller.signal)).rejects.toThrow(/取消/);
    await f.backend.close();
    expect(f.events.some((event) => event.type === 'observation' && event.value.account)).toBe(
      false,
    );
  });

  it('明确的加载错误能结束启动等待并标记不可自动重试', async () => {
    const f = await fixture('fail-boot');
    await expect(f.backend.initialize(new AbortController().signal)).rejects.toThrow(/unsupported/);
    await f.backend.close();
    expect(f.events.at(-1)).toMatchObject({ type: 'exit', code: 1, retryable: false });
  });
});
