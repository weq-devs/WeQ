// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { externalMcpHttpOptions } from '../src/main/mcp/external_http';
import { ExternalMcpHub } from '../src/main/mcp/external';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('合成监听失败');
  return new URL(`http://127.0.0.1:${address.port}/mcp`);
}

it.each([301, 302, 307, 308])(
  'both actual transports refuse %s redirects without forwarding synthetic credentials',
  async (status) => {
    const received: unknown[] = [];
    const target = await listen((req, res) => {
      received.push(req.headers);
      res.end('{}');
    });
    const source = await listen((_req, res) => {
      res.writeHead(status, { location: target.href });
      res.end();
    });
    for (const Transport of [StreamableHTTPClientTransport, SSEClientTransport]) {
      const client = new Client({ name: 'synthetic', version: '1' });
      try {
        await expect(
          client.connect(
            new Transport(
              source,
              externalMcpHttpOptions(source, { 'X-Synthetic-Key': 'not-a-real-secret' }),
            ),
          ),
        ).rejects.toThrow();
      } finally {
        await client.close();
      }
    }
    expect(received).toEqual([]);
  },
);

it('also rejects a direct cross-origin SSE endpoint before making a request', async () => {
  let received = false;
  const target = await listen((_req, res) => {
    received = true;
    res.end('{}');
  });
  const options = externalMcpHttpOptions(new URL('http://127.0.0.1:1/mcp'));
  await expect(
    options.fetch(target, { headers: { 'X-Synthetic-Key': 'synthetic' } }),
  ).rejects.toThrow('跨来源');
  expect(received).toBe(false);
});

it('drops an SSE server that never announces its endpoint and keeps the available tools', async () => {
  const sse = new EventTarget();
  const stalled = await listen((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    res.once('close', () => sse.dispatchEvent(new Event('close')));
    res.writeHead(200, { 'content-type': 'text/event-stream' }).flushHeaders();
    sse.dispatchEvent(new Event('open'));
  });
  const available = await listen(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let text = '';
    for await (const chunk of req) text += chunk;
    const { id, method } = JSON.parse(text);
    if (id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const result =
      method === 'initialize'
        ? {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : { tools: [{ name: 'read_fixture', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  const hub = new ExternalMcpHub();
  hub.configure(`stalled=${stalled.href}\navailable=${available.href}`);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const opened = once(sse, 'open');
    const disconnected = once(sse, 'close');
    const pending = hub.specs();
    await opened;
    await vi.waitFor(() =>
      expect(hub.status().find((server) => server.name === 'available')?.connected).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).map((tool) => tool.function.name)).toEqual([
      'mcp__available__read_fixture',
    ]);
    await disconnected;
    expect(hub.status().find((server) => server.name === 'stalled')).toMatchObject({
      connected: false,
      error: expect.stringContaining('超时'),
    });
  } finally {
    await hub.dispose();
  }
});
