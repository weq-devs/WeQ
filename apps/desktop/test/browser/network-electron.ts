import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { app, session } from 'electron';
import { electronNetworkFetch } from '../../src/main/network';

const origin = createServer(async (request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/final' });
    response.end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      url: request.url,
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      range: request.headers.range,
      body: Buffer.concat(chunks).toString('hex'),
    }),
  );
});
let requests = 0;
const proxy = createServer((request, response) => {
  requests++;
  const upstream = httpRequest(
    request.url!,
    { method: request.method, headers: request.headers },
    (incoming) => {
      response.writeHead(incoming.statusCode!, incoming.headers);
      incoming.pipe(response);
    },
  );
  request.pipe(upstream);
  upstream.on('error', () => {
    response.statusCode = 502;
    response.end();
  });
});
const sockets = new Set<import('node:net').Socket>();
proxy.on('connect', (request, socket, head) => {
  requests++;
  const [host, port] = request.url!.split(':');
  const upstream = connect(Number(port), host, () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
});
for (const server of [origin, proxy])
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
async function main() {
  await app.whenReady();
  try {
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const originPort = (origin.address() as import('node:net').AddressInfo).port;
    const proxyPort = (proxy.address() as import('node:net').AddressInfo).port;
    await session.defaultSession.setProxy({
      proxyRules: `http=127.0.0.1:${proxyPort}`,
      proxyBypassRules: '<-loopback>',
    });
    const root = `http://127.0.0.1:${originPort}`;
    console.log('Checking Chromium GET transport');
    const response = await electronNetworkFetch(`${root}/redirect`, {
      signal: AbortSignal.timeout(10000),
      headers: { Cookie: 'fixture=1', Range: 'bytes=2-', Authorization: 'Bearer fixture' },
    });
    assert.equal(response.url, `${root}/final`);
    assert.deepEqual(await response.json(), {
      url: '/final',
      cookie: 'fixture=1',
      range: 'bytes=2-',
      authorization: 'Bearer fixture',
      body: '',
    });
    console.log('Checking Chromium POST transport');
    const written = await electronNetworkFetch(`${root}/write`, {
      signal: AbortSignal.timeout(10000),
      method: 'POST',
      headers: { Cookie: 'fixture=1', 'Content-Length': '3' },
      body: new Uint8Array([0, 1, 255]),
    });
    assert.deepEqual(await written.json(), { url: '/write', cookie: 'fixture=1', body: '0001ff' });
    assert.ok(requests > 0);
    console.log('Chromium 代理、Cookie、Authorization、Range、重定向最终地址及二进制请求通过');
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    origin.close();
    proxy.close();
    app.quit();
  }
}
const watchdog = setTimeout(() => {
  console.error('Chromium network smoke timed out');
  app.exit(1);
}, 30000);
void main().finally(() => clearTimeout(watchdog));
