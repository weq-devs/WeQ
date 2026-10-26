// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { externalMcpHttpOptions } from '../src/main/mcp/external_http';

const servers: http.Server[] = [];
afterEach(async () => {
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
