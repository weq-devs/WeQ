// @vitest-environment node
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from '../src/main/web/http';
import { startMcpServer, stopMcpServer } from '../src/main/mcp/server';
import { OneBotServer, type OneBotBackend } from '../src/main/onebot/server';
import { AssistantResourceServer } from '../src/main/weq_assistant/server';

vi.mock('../src/main/mcp/tools', () => ({ AI_TOOLS: [] }));

afterEach(async () => {
  await stopMcpServer();
  vi.restoreAllMocks();
});

// 使用真实回环监听器验证启动路径，但把候选端口映射到随机端口，不占用日常服务入口。
function captureAttempts(busy: ReadonlySet<number>) {
  const attempts: number[] = [];
  const listen = http.Server.prototype.listen;
  vi.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
    this: http.Server,
    ...args: unknown[]
  ) {
    const port = args[0];
    if (typeof port !== 'number') throw new Error('测试仅支持数字端口');
    attempts.push(port);
    if (busy.has(port)) {
      queueMicrotask(() =>
        this.emit('error', Object.assign(new Error('busy'), { code: 'EADDRINUSE' })),
      );
      return this;
    }
    const callback = args.find((arg): arg is () => void => typeof arg === 'function');
    return listen.call(this, 0, '127.0.0.1', callback);
  });
  return attempts;
}

it('Web 启动回退不绑定 Remote 入口，并返回真实随机监听端口', async () => {
  const attempts = captureAttempts(new Set([7690]));
  const { server, port } = await startServer({
    port: 7690,
    host: '127.0.0.1',
    publicDir: '.',
    auth: { login: vi.fn(), logout: vi.fn(), isAuthed: () => false },
    trpc: vi.fn(),
  });
  try {
    expect(attempts).toEqual([7690, 7693]);
    expect(port).toBe((server.address() as { port: number }).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('MCP 自定义端口回退不占用新 OneBot 范围', async () => {
  const attempts = captureAttempts(new Set([48799]));
  const port = await startMcpServer({ port: 48799, token: 'synthetic-only' });
  expect(attempts).toEqual([48799, 48820]);
  expect((await fetch(`http://127.0.0.1:${port}/mcp`)).status).toBe(401);
});

it('OneBot 回退为后启动的 HTTP 服务器保留其指定端口', async () => {
  const attempts = captureAttempts(new Set([50000]));
  const backend: OneBotBackend = {
    self: async () => ({ user_id: 99, nickname: '合成账号' }),
    status: () => ({ online: true, good: true }),
    group: vi.fn(),
    send: vi.fn(),
    typing: vi.fn(),
    subscribe: () => () => {},
  };
  const server = new OneBotServer(backend);
  try {
    const statuses = await server.startConfigured({
      webSocketServers: [{ id: 'ws', port: 50000, token: '' }],
      httpServers: [{ id: 'http', port: 50001, token: '' }],
    });
    expect(attempts).toEqual([50000, 50002, 50001]);
    expect(statuses.every((status) => status.running)).toBe(true);
  } finally {
    server.stop();
  }
});

it('公众号资源服务自定义端口回退也避开 Web 与 Remote', async () => {
  const attempts = captureAttempts(new Set([7689]));
  const root = await mkdtemp(join(tmpdir(), 'weq-service-ports-'));
  const server = new AssistantResourceServer();
  try {
    await server.start(7689, root);
    expect(attempts).toEqual([7689, 7702]);
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
  }
});
