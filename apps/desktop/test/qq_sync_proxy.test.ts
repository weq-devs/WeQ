// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { createServer, connect, type Socket, type Server } from 'node:net';
import { once } from 'node:events';
import { FrameBuffer, QqSyncProxy } from '../src/main/qq_sync/proxy';
import {
  buildServerFrame,
  buildServerPlain,
  parseServerFrame,
  parseServerPlain,
  buildClientReadNotify,
  clientReadTargets,
} from '@weqbot/protocol/qq-sync';

const proxies: QqSyncProxy[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const proxy of proxies.splice(0)) await proxy.close();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
function frame(body = Buffer.from([8, 1])) {
  return buildServerFrame({
    uin: '10001',
    key: Buffer.alloc(16, 7),
    plain: buildServerPlain({
      sequence: 0x90000001,
      command: 'trpc.msg.olpush.OlPushService.MsgPush',
      body,
    }),
  });
}
function reader(socket: Socket) {
  let buffer: Buffer = Buffer.alloc(0);
  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
  });
  return async (size: number) => {
    await new Promise<void>((resolve, reject) => {
      const limit = setTimeout(() => {
        clearInterval(timer);
        reject(Error('read timeout'));
      }, 2000);
      const timer = setInterval(() => {
        if (buffer.length >= size) {
          clearTimeout(limit);
          clearInterval(timer);
          resolve();
        }
      }, 5);
    });
    const result = buffer.subarray(0, size);
    buffer = buffer.subarray(size);
    return result;
  };
}
it('分片、连续帧与前导登录数据保持完整边界', () => {
  const f = frame();
  const observer = new FrameBuffer();
  expect(observer.feed(Buffer.concat([Buffer.from('login'), f.subarray(0, 9)]))).toEqual([]);
  expect(observer.atBoundary).toBe(false);
  expect(observer.feed(Buffer.concat([f.subarray(9), f]))).toEqual([f, f]);
  expect(observer.atBoundary).toBe(true);
});
it('已读通知按真实样本字段构造，支持群和普通私聊', () => {
  const targets = [
    { kind: 'group', groupUin: 55555, sequence: 90 },
    { kind: 'c2c', targetUid: 'u_peer', sequence: 91, timestamp: 1700000000 },
  ] as const;
  for (const target of targets)
    expect(
      clientReadTargets(buildClientReadNotify({ uin: '10001', uid: 'u_self' }, target)),
    ).toEqual([target]);
});
it('补投等待完整帧，按业务身份去重，并拒绝旧会话', async () => {
  let upstream: Socket | undefined;
  const remote = createServer((socket) => {
    upstream = socket;
    sockets.push(socket);
  });
  servers.push(remote);
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const remotePort = (remote.address() as { port: number }).port;
  const proxy = new QqSyncProxy();
  proxies.push(proxy);
  await proxy.start(0);
  // 使用真实临时监听端口，绕过固定端口依赖。
  const proxyPort = (proxy as unknown as { server: Server }).server.address() as { port: number };
  proxy.setCredential({
    uin: '10001',
    key: Buffer.alloc(16, 7).toString('hex'),
    generation: 'first',
  });
  const client = connect(proxyPort.port, '127.0.0.1');
  sockets.push(client);
  const take = reader(client);
  await once(client, 'connect');
  client.write(`CONNECT 127.0.0.1:${remotePort} HTTP/1.1\r\n\r\n`);
  await take(Buffer.byteLength('HTTP/1.1 200 Connection Established\r\n\r\n'));
  const original = frame();
  upstream!.write(original);
  expect(await take(original.length)).toEqual(original);
  upstream!.write(original.subarray(0, 17));
  await take(17);
  const body = Buffer.from([8, 2]);
  let done = false;
  const delivery = proxy.deliver('10001', 'first', 'message:one', body).then((result) => {
    done = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done).toBe(false);
  upstream!.write(original.subarray(17));
  expect(await take(original.length - 17)).toEqual(original.subarray(17));
  expect(await delivery).toEqual({ delivered: true, duplicate: false });
  const length = (await take(4)).readUInt32BE();
  const packet = Buffer.alloc(length);
  packet.writeUInt32BE(length);
  (await take(length - 4)).copy(packet, 4);
  expect(parseServerPlain(parseServerFrame(packet, Buffer.alloc(16, 7)).plain).body).toEqual(body);
  expect(await proxy.deliver('10001', 'first', 'message:one', body)).toEqual({
    delivered: true,
    duplicate: true,
  });
  proxy.setCredential({
    uin: '10001',
    key: Buffer.alloc(16, 8).toString('hex'),
    generation: 'second',
  });
  await expect(proxy.deliver('10001', 'first', 'message:two', body)).rejects.toThrow();
});
