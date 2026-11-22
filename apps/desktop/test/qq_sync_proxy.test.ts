// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createServer, connect, type Socket, type Server } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encode } from '@weqbot/protocol';
import { decodePushEnvelope } from '../../../vendor/weqbot/packages/protocol/src/push/decode';
import { PUSH_MSG_BODY } from '../../../vendor/weqbot/packages/protocol/src/msg/schemas';
import {
  FRIEND_RECALL,
  GROUP_NOTIFY_BODY,
} from '../../../vendor/weqbot/packages/protocol/src/push/schemas';
import { RecallJournal } from '../src/main/qq_sync/recall_journal';
import { FrameBuffer, QqSyncProxy } from '../src/main/qq_sync/proxy';
import {
  buildServerFrame,
  buildServerPlain,
  parseServerFrame,
  parseServerPlain,
  buildClientReadNotify,
  clientReadTargets,
  inspectRecallPush,
  wrapClientMessage,
} from '@weqbot/protocol/qq-sync';

const proxies: QqSyncProxy[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const proxy of proxies.splice(0)) await proxy.close();
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
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
it('切换端口保留已建立的隧道，端口占用或保存失败时保留原监听', async () => {
  const remote = createServer((socket) => {
    sockets.push(socket);
    socket.pipe(socket);
  });
  servers.push(remote);
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const remotePort = (remote.address() as { port: number }).port;
  const proxy = new QqSyncProxy();
  proxies.push(proxy);
  const originalPort = await proxy.start(0);
  expect(proxy.status().connecting).toBe(false);

  async function tunnel(port: number) {
    const client = connect(port, '127.0.0.1');
    sockets.push(client);
    const take = reader(client);
    await once(client, 'connect');
    client.write(`CONNECT 127.0.0.1:${remotePort} HTTP/1.1\r\n\r\n`);
    const reply = 'HTTP/1.1 200 Connection Established\r\n\r\n';
    expect((await take(Buffer.byteLength(reply))).toString()).toBe(reply);
    return { client, take };
  }

  const persist = vi.fn(async () => {});
  await expect(proxy.start(remotePort, persist)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(persist).not.toHaveBeenCalled();
  await expect(
    proxy.start(0, async () => {
      throw new Error('配置写入失败');
    }),
  ).rejects.toThrow('配置写入失败');
  const original = await tunnel(originalPort);
  expect(proxy.status().connecting).toBe(true);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000);
  expect(proxy.status().connecting).toBe(false);
  clock.mockRestore();

  const nextPort = await proxy.start(0, persist);
  expect(persist).toHaveBeenCalledOnce();
  const fresh = await tunnel(nextPort);
  original.client.write('old connection');
  fresh.client.write('new connection');
  expect((await original.take(14)).toString()).toBe('old connection');
  expect((await fresh.take(14)).toString()).toBe('new connection');
  const rejected = connect(originalPort, '127.0.0.1');
  sockets.push(rejected);
  await expect(once(rejected, 'connect')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

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
it('公众号已读通知保留手机样本中的时间和显式零值字段', () => {
  const target = {
    kind: 'official',
    targetUid: 'u_peer',
    timestamp: 1700000000,
    sequence: 0,
  } as const;
  const body = buildClientReadNotify({ uin: '10001', uid: 'u_self' }, target);
  const message = decodePushEnvelope(body).messages[0]!;
  expect(message.contentHead).toMatchObject({ msgType: 528, subType: 8, c2cCmd: 8 });
  expect(Buffer.from(message.body!.msgContent!).toString('hex')).toBe(
    '0a180a06755f706565721080e2cfaa0648005800a00100a80100',
  );
  expect(clientReadTargets(body)).toEqual([target]);
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

function privateRecall() {
  return wrapClientMessage(
    encode(PUSH_MSG_BODY, {
      responseHead: { fromUid: 'u_peer', toUid: 'u_self' },
      contentHead: { msgType: 528, subType: 138 },
      body: {
        msgContent: encode(FRIEND_RECALL, {
          info: {
            fromUid: 'u_peer',
            toUid: 'u_self',
            clientSequence: 8,
            time: 1700000000,
            newId: 72057594037927937n,
          },
        }),
      },
    }),
  );
}
it('撤回与其他事件同包时仅移除撤回子消息，未知字段和未保护会话逐字保留', () => {
  const normal = wrapClientMessage(encode(PUSH_MSG_BODY, { contentHead: { msgType: 82 } }));
  const unknown = Buffer.from([0x98, 0x06, 0x01]);
  const body = Buffer.concat([privateRecall(), normal, unknown]);
  const blocked = inspectRecallPush(body, 'u_self', () => true, true);
  expect(blocked.body).toEqual(Buffer.concat([normal, unknown]));
  expect(blocked.removed).toBe(1);
  expect(blocked.observed[0]?.recalls[0]).toMatchObject({
    kind: 'c2c',
    conv: 'u_peer',
    clientSequence: 8,
    timestamp: 1700000000,
  });
  expect(inspectRecallPush(body, 'u_self', () => false, true).body).toEqual(body);
  expect(inspectRecallPush(body, 'u_other_account', () => true, true).body).toEqual(body);
});
it('群管理员一次撤回多条时完整提取每条身份，包体不完整时透传', () => {
  const payload = encode(GROUP_NOTIFY_BODY, {
    groupUin: 20002,
    recall: {
      operatorUid: 'u_admin',
      recallMessages: [
        { sequence: 10, time: 1700000000, authorUid: 'u_a' },
        { sequence: 11, time: 1700000001, authorUid: 'u_b' },
      ],
    },
  });
  const prefix = Buffer.alloc(7);
  prefix.writeUInt16BE(payload.length, 5);
  const body = wrapClientMessage(
    encode(PUSH_MSG_BODY, {
      contentHead: { msgType: 732, subType: 17 },
      body: { msgContent: Buffer.concat([prefix, payload]) },
    }),
  );
  const filtered = inspectRecallPush(body, 'u_self', () => true, true);
  expect(filtered.observed[0]?.recalls.map((row) => row.sequence)).toEqual([10, 11]);
  expect(filtered.removed).toBe(1);
  const broken = wrapClientMessage(
    encode(PUSH_MSG_BODY, {
      contentHead: { msgType: 732, subType: 17 },
      body: { msgContent: Buffer.from([1, 2, 3]) },
    }),
  );
  expect(inspectRecallPush(broken, 'u_self', () => true, true).body).toEqual(broken);
});
it('实际代理对分片撤回重新封装，落盘后过滤、确认后删除，停用后透传', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recall-proxy-'));
  roots.push(root);
  const journal = new RecallJournal(root);
  const proxy = new QqSyncProxy(journal);
  proxies.push(proxy);
  let upstream!: Socket;
  const remote = createServer((socket) => {
    upstream = socket;
    sockets.push(socket);
  });
  servers.push(remote);
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  await proxy.start(0);
  const port = ((proxy as unknown as { server: Server }).server.address() as { port: number }).port;
  proxy.setCredential({
    uin: '10001',
    selfUid: 'u_self',
    key: Buffer.alloc(16, 7).toString('hex'),
    generation: 'first',
  });
  const policy = { owner: 'source-a', enabled: true, block: true, all: true, targets: [] };
  proxy.setRecallPolicy('10001', 'first', policy);
  const client = connect(port, '127.0.0.1');
  sockets.push(client);
  const take = reader(client);
  await once(client, 'connect');
  client.write(`CONNECT 127.0.0.1:${(remote.address() as { port: number }).port} HTTP/1.1\r\n\r\n`);
  await take(Buffer.byteLength('HTTP/1.1 200 Connection Established\r\n\r\n'));
  // 第一帧建立账号与帧边界，后续帧才进入完整帧过滤。
  const template = frame();
  upstream.write(template);
  expect(await take(template.length)).toEqual(template);
  const original = frame(privateRecall());
  upstream.write(original.subarray(0, 17));
  upstream.write(original.subarray(17));
  const header = await take(4);
  const received = Buffer.concat([header, await take(header.readUInt32BE() - 4)]);
  const decoded = parseServerPlain(parseServerFrame(received, Buffer.alloc(16, 7)).plain);
  expect(decoded.sequence).toBe(0x90000001);
  expect(decoded.body.length).toBe(0);
  const pending = new RecallJournal(root).take('source-a');
  expect(pending).toHaveLength(1);
  expect(pending[0]?.events[0]?.recalls[0]?.conv).toBe('u_peer');
  expect(journal.take('source-b')).toEqual([]);
  expect(
    proxy.takeRecallEvents(
      '10001',
      'first',
      pending.map((entry) => entry.id),
    ),
  ).toEqual([]);
  proxy.setRecallPolicy('10001', 'first', { ...policy, enabled: false });
  upstream.write(original);
  expect(await take(original.length)).toEqual(original);
  proxy.setRecallPolicy('10001', 'first', policy);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11000);
  upstream.write(original);
  expect(await take(original.length)).toEqual(original);
  clock.mockRestore();
  proxy.setRecallPolicy('10001', 'first', policy);
  vi.spyOn(journal, 'append').mockImplementation(() => {
    throw new Error('留存写入失败');
  });
  upstream.write(original);
  expect(await take(original.length)).toEqual(original);
  expect(proxy.status().recallError).toBe('留存写入失败');
});
