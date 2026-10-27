import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentLabStore } from '@weq/agentlab';
import { WebSocketServer, WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { NapcatAdapter, startBot, type BotConfig } from '../../bot/src/index';
import { makeBackupPersona } from './fixtures/backup_persona';

const roots: string[] = [];
const servers: Server[] = [];
const sockets: WebSocketServer[] = [];
const webUi = vi.hoisted(() => ({
  onReload: undefined as (() => Promise<{ ok: boolean; message?: string }>) | undefined,
}));
vi.mock('../../bot/src/webui/server', () => ({
  startWebUi: async (options: { onReload: () => Promise<{ ok: boolean; message?: string }> }) => {
    webUi.onReload = options.onReload;
    return { close: () => {} };
  },
}));
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    sockets.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) client.terminate();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function websocket() {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  sockets.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('夹具监听失败');
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

it('真实适配器关闭时立即结束挂起 RPC，不等待 action 超时且不重发', async () => {
  const { server, url } = await websocket();
  let calls = 0;
  server.on('connection', (ws) => ws.on('message', () => calls++));
  const adapter = new NapcatAdapter({ type: 'napcat', wsUrl: url, actionTimeoutMs: 30_000 });
  try {
    await adapter.connect();
    const outcome = adapter.callAction('synthetic', {}).catch((error: Error) => error.message);
    await vi.waitFor(() => expect(calls).toBe(1));
    adapter.close();
    expect(await Promise.race([outcome, delay(200).then(() => 'hung')])).toContain('不可自动重试');
    expect(calls).toBe(1);
  } finally {
    adapter.close();
  }
});

it('真实 Bot 停止中断模型慢流，清空下一条并关闭 WebSocket，不产生回复', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), 'weq-bot-stop-'));
  roots.push(root);
  const persona = makeBackupPersona();
  const personaDir = join(root, 'persona');
  new AgentLabStore(personaDir).savePersona({ persona, pairs: [] });
  let calls = 0,
    disconnected = false;
  const http = createServer((_req, res) => {
    calls++;
    res.on('close', () => {
      disconnected = true;
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"choices":[');
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('夹具监听失败');
  const { server, url } = await websocket();
  const outgoing: string[] = [];
  server.on('connection', (ws) => ws.on('message', (message) => outgoing.push(String(message))));
  const bot = await startBot({
    adapter: { type: 'napcat', wsUrl: url },
    selfId: 'bot',
    personaDir,
    llmProviders: [
      {
        id: 'synthetic-provider',
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: 'synthetic',
      },
    ],
  });
  try {
    const peer = [...server.clients][0]!;
    for (const text of ['first', 'second'])
      peer.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          user_id: 'peer-a',
          message: text,
        }),
      );
    await vi.waitFor(() => expect(calls).toBe(1));
    await bot.stop();
    await vi.waitFor(() => expect(disconnected).toBe(true));
    await vi.waitFor(() => expect(peer.readyState).toBe(WebSocket.CLOSED));
    expect(calls).toBe(1);
    expect(outgoing).toEqual([]);
  } finally {
    await bot.stop();
  }
});

it('重载读取配置期间停止，不会在配置迟到后重新连接', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), 'weq-bot-reload-'));
  roots.push(root);
  const personaDir = join(root, 'persona');
  new AgentLabStore(personaDir).savePersona({ persona: makeBackupPersona(), pairs: [] });
  const { server, url } = await websocket();
  let connections = 0,
    reading = false;
  server.on('connection', () => connections++);
  const config: BotConfig = {
    adapter: { type: 'napcat', wsUrl: url },
    personaDir,
    selfId: 'bot',
    llmProviders: [],
    webui: { id: 'synthetic', key: 'synthetic', port: 0 },
  };
  let resume = (_config: BotConfig) => {};
  const pending = new Promise<BotConfig>((resolve) => {
    resume = resolve;
  });
  const bot = await startBot(config, {
    reloadConfig: () => {
      reading = true;
      return pending;
    },
  });
  const reloading = webUi.onReload!();
  try {
    await vi.waitFor(() => expect(reading).toBe(true));
    await bot.stop();
    resume(config);
    expect((await reloading).ok).toBe(false);
    expect(connections).toBe(1);
  } finally {
    resume(config);
    await bot.stop();
    await reloading;
  }
});

it('提供方自定义期限经过实际 Bot 链路生效，超时释放队列且用量正确收尾', async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = mkdtempSync(join(tmpdir(), 'weq-bot-timeout-'));
  roots.push(root);
  const personaDir = join(root, 'persona');
  new AgentLabStore(personaDir).savePersona({ persona: makeBackupPersona(), pairs: [] });
  let calls = 0;
  const http = createServer((_req, res) => {
    calls++;
    if (calls === 1) return;
    res.end(JSON.stringify({ choices: [{ message: { content: '合成回复' } }] }));
  });
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('夹具监听失败');
  const { server, url } = await websocket();
  const outgoing: unknown[] = [];
  server.on('connection', (ws) =>
    ws.on('message', (message) => {
      const packet = JSON.parse(String(message)) as { echo: string };
      outgoing.push(packet);
      ws.send(JSON.stringify({ echo: packet.echo, retcode: 0, data: { message_id: 'synthetic' } }));
    }),
  );
  const bot = await startBot({
    adapter: { type: 'napcat', wsUrl: url },
    selfId: 'bot',
    personaDir,
    llmProviders: [
      {
        id: 'synthetic-provider',
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: 'synthetic',
        timeoutMs: 150,
      },
    ],
  });
  try {
    const peer = [...server.clients][0]!;
    for (const text of ['slow', 'fast'])
      peer.send(
        JSON.stringify({
          post_type: 'message',
          message_type: 'private',
          user_id: '12345',
          message: text,
        }),
      );
    await vi.waitFor(() => expect(outgoing).toHaveLength(1));
    expect(calls).toBe(2);
    await bot.stop();
    const stats = JSON.parse(readFileSync(join(root, 'data/stats.json'), 'utf8')) as {
      totals: { failedCalls: number; llmCalls: number };
    };
    expect(stats.totals).toMatchObject({ failedCalls: 1, llmCalls: 2 });
  } finally {
    await bot.stop();
  }
});
