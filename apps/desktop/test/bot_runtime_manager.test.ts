// @vitest-environment node
/**
 * WeqBot daemon 的进程管理。
 *
 * 用**真的**控制通道 socket（假 daemon 在 `test/fixtures/fake-weqbot-daemon.mjs`），
 * 而不是 mock 掉 `connectControlSocket` —— 管理器最容易出错的地方恰恰是 socket 的
 * 时序：先试连、清理残留、spawn 后轮询。mock 掉传输层就把这些全绕过去了。
 *
 * 盯四件事：
 *   1. 账号打开 → spawn 进程、能 ping 通、能收发 `onebot.get` / `onebot.set`；
 *   2. 同 uin 再次 `ensure` 复用，不重复 spawn；
 *   3. `shutdown` 让 daemon 退出并释放 socket；
 *   4. `disconnectAll`（WeQ 退出）**不发 shutdown**，daemon 继续活着、
 *      下一个 runtime 能直接接管。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BotRuntime } from '../src/main/bot_runtime/manager';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_DAEMON = join(here, 'fixtures', 'fake-weqbot-daemon.mjs');

let dir: string;

function makeRuntime(): BotRuntime {
  return new BotRuntime({
    resolvePaths: ({ uin }) => ({
      node: process.execPath,
      // 假 daemon 直接 import `@weqbot/control`，而那个包导出的是 TS 源码
      // （workspace 包没有构建步骤），所以要走 tsx。
      nodeArgs: ['--import', 'tsx'],
      entry: FAKE_DAEMON,
      // 假 daemon 不加载 native，给个占位值即可。
      nativeDir: dir,
      socketPath: join(dir, `control-${uin}.sock`),
    }),
    connectTimeoutMs: 15_000,
  });
}

function socketOf(uin: string): string {
  return join(dir, `control-${uin}.sock`);
}

let runtime: BotRuntime;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'weq-bot-runtime-'));
  runtime = makeRuntime();
});

afterEach(async () => {
  runtime.disconnectAll();
  // 等假 daemon 自己退出，否则临时目录删不掉（socket 文件还在用）。
  await waitFor(() => !existsSync(socketOf('10002')), 3_000).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

it('账号打开时拉起 daemon，并能收发 onebot 配置', async () => {
  const before = await runtime.getOneBot('10002');
  expect(before.configured).toBe(false);
  expect(existsSync(socketOf('10002'))).toBe(true);

  const saved = await runtime.setOneBot('10002', {
    networks: {
      wsServers: [{ name: 'client', port: 16700, messageFormat: 'array', reportSelfMessage: true }],
      wsClients: [],
      httpServers: [],
      httpClients: [],
    },
  });
  expect(saved.configured).toBe(true);
  expect(saved.config?.networks.wsServers[0]?.port).toBe(16700);

  const readBack = await runtime.getOneBot('10002');
  expect(readBack.config?.networks.wsServers[0]?.name).toBe('client');
});

it('同 uin 再次 ensure 复用同一个 daemon，不重复 spawn', async () => {
  await runtime.getOneBot('10002');
  await runtime.getOneBot('10002');
  await runtime.getOneBot('10002');
  expect(runtime.size).toBe(1);
});

it('shutdown 让 daemon 退出并释放 socket', async () => {
  const path = socketOf('10002');
  await runtime.getOneBot('10002');
  expect(existsSync(path)).toBe(true);

  await runtime.shutdown('10002', 'test');
  expect(runtime.size).toBe(0);
  await waitFor(() => !existsSync(path));
});

it('disconnectAll（WeQ 退出）不杀 daemon：socket 仍在，可被重新接管', async () => {
  const path = socketOf('10002');
  await runtime.getOneBot('10002');
  expect(existsSync(path)).toBe(true);

  runtime.disconnectAll();
  expect(runtime.size).toBe(0);

  // socket 还在 —— daemon 还活着。
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(existsSync(path)).toBe(true);

  // 模拟 WeQ 重启：新的 runtime 直接接管，不重新 spawn（入口故意指向不存在的文件，
  // 一旦真的 spawn 就会立刻失败）。
  const next = new BotRuntime({
    resolvePaths: ({ uin }) => ({
      node: process.execPath,
      nodeArgs: ['--import', 'tsx'],
      entry: join(dir, 'never-spawned.mjs'),
      nativeDir: dir,
      socketPath: join(dir, `control-${uin}.sock`),
    }),
    connectTimeoutMs: 5_000,
  });
  const state = await next.getOneBot('10002');
  expect(state.configured).toBe(false);
  // 接管之后再用 shutdown 收掉这个 daemon，别留给下一个测试。
  await next.shutdown('10002', 'cleanup');
});

it('attach 成功后同一进程再 attach 返回错误', async () => {
  const params = {
    pid: 1234,
    uid: 'uid-1',
    guid: 'guid-1',
    a2: 'aa',
    d2: 'bb',
    d2Key: 'cc',
    subAppId: 537403759,
  };
  const first = await runtime.attach('10002', params);
  expect(first.state).toBe('online');
  await expect(runtime.attach('10002', params)).rejects.toThrow(/ALREADY_ONLINE/);
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待超时');
}
