import { createServer } from 'node:http';
import { connect } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import {
  networkFetch,
  clearSourceHealth,
  downloadSources,
  orderSources,
  recordSourceHealth,
  setNetworkTransport,
  withNetworkTransport,
  resolveDownloadSources,
} from '../src/index';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setNetworkTransport();
  clearSourceHealth();
});
it('宿主与请求作用域注入保留完整请求参数', async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response('host'));
  setNetworkTransport(transport);
  const init = {
    method: 'POST',
    body: new Uint8Array([1, 2]),
    headers: { Cookie: 'fixture', Range: 'bytes=2-' },
  };
  await networkFetch('https://fixture.invalid', init);
  expect(transport).toHaveBeenCalledWith('https://fixture.invalid', init);
  const other = vi.fn<typeof fetch>(async () => new Response('scoped'));
  expect(
    await withNetworkTransport(other, async () =>
      (await networkFetch('https://fixture.invalid')).text(),
    ),
  ).toBe('scoped');
  expect(await (await networkFetch('https://fixture.invalid')).text()).toBe('host');
});
it('只为明确 GitHub Release 资产扩展镜像，不代理业务接口', () => {
  expect(
    downloadSources('https://github.com/weq-devs/WeQ/releases/download/v2.7.2/file').length,
  ).toBeGreaterThan(3);
  expect(downloadSources('https://api.github.com/repos/weq-devs/WeQ/releases')).toHaveLength(1);
  expect(downloadSources('https://modelscope.cn/file')).toHaveLength(1);
  recordSourceHealth('https://second.invalid/file', true);
  expect(orderSources(['https://first.invalid/file', 'https://second.invalid/file'])[0]).toContain(
    'second',
  );
});
it('冷启动仅探测三个源，取消其余响应并复用成功源', async () => {
  const transport = vi.fn<typeof fetch>(async () => new Response('data'));
  setNetworkTransport(transport);
  const sources = ['a', 'b', 'c', 'd'].map((host) => `https://${host}.invalid/file`);
  await resolveDownloadSources(sources);
  expect(transport).toHaveBeenCalledTimes(3);
  await resolveDownloadSources(sources);
  expect(transport).toHaveBeenCalledTimes(3);
});
it('环境代理与 NO_PROXY 通过实际 HTTP 隧道验证', async () => {
  let tunnels = 0;
  const origin = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.end('origin');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        body: Buffer.concat(chunks).toString('hex'),
        cookie: request.headers.cookie,
        authorization: request.headers.authorization,
      }),
    );
  });
  const proxy = createServer();
  proxy.on('connect', (request, socket, head) => {
    tunnels++;
    const [host, port] = request.url!.split(':');
    const upstream = connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const originPort = (origin.address() as import('node:net').AddressInfo).port;
  const proxyPort = (proxy.address() as import('node:net').AddressInfo).port;
  try {
    vi.stubEnv('HTTP_PROXY', `http://127.0.0.1:${proxyPort}`);
    vi.stubEnv('http_proxy', undefined);
    vi.stubEnv('https_proxy', undefined);
    vi.stubEnv('no_proxy', undefined);
    vi.stubEnv('NO_PROXY', 'localhost');
    expect(await (await networkFetch(`http://127.0.0.1:${originPort}`)).text()).toBe('origin');
    expect(tunnels).toBe(1);
    expect(
      await (
        await networkFetch(`http://127.0.0.1:${originPort}`, {
          method: 'POST',
          headers: { Cookie: 'fixture=1', Authorization: 'Bearer fixture', 'Content-Length': '3' },
          body: new Uint8Array([0, 1, 255]),
        })
      ).json(),
    ).toEqual({ body: '0001ff', cookie: 'fixture=1', authorization: 'Bearer fixture' });
    const beforeBypass = tunnels;
    expect(await (await networkFetch(`http://localhost:${originPort}`)).text()).toBe('origin');
    expect(tunnels).toBe(beforeBypass);
  } finally {
    origin.closeAllConnections();
    proxy.closeAllConnections();
    origin.close();
    proxy.close();
  }
});
