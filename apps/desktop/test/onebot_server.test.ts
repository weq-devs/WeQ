// @vitest-environment node
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  OneBotServer,
  parseSegments,
  type BridgeMessage,
  type OneBotBackend,
} from '../src/main/onebot/server';

const servers: OneBotServer[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.stop();
});
const incoming = (patch: Partial<BridgeMessage> = {}): BridgeMessage => ({
  key: 'group:42:9007199254740993123',
  peerType: 'group',
  targetId: '42',
  senderUin: 7,
  nickname: '合成用户',
  time: Math.floor(Date.now() / 1000),
  sequence: 91,
  message: [{ type: 'text', data: { text: 'hello' } }],
  ...patch,
});

async function setup() {
  let deliver: (msg: BridgeMessage) => void = () => {};
  const unsubscribe = vi.fn();
  const send = vi
    .fn<OneBotBackend['send']>()
    .mockImplementation(async (target, message) =>
      incoming({ ...target, key: 'sent:1', senderUin: 99, sequence: 92, message }),
    );
  const backend: OneBotBackend = {
    status: () => ({ online: true, good: true }),
    self: async () => ({ user_id: 99, nickname: '合成账号' }),
    group: async (id) => ({ group_id: Number(id), group_name: '合成群' }),
    send,
    typing: vi.fn(),
    subscribe: (handler) => {
      deliver = handler;
      return unsubscribe;
    },
  };
  const server = new OneBotServer(backend, 'synthetic-token');
  servers.push(server);
  const port = await server.start(0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Authorization: 'Bearer synthetic-token' },
  });
  sockets.push(ws);
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await once(ws, 'open');
  const request = async (action: string, params: Record<string, unknown> = {}) => {
    const echo = `req-${messages.length}`;
    ws.send(JSON.stringify({ action, params, echo }));
    await vi.waitFor(() => expect(messages.some((m) => m.echo === echo)).toBe(true));
    return messages.find((m) => m.echo === echo)!;
  };
  return {
    server,
    port,
    ws,
    messages,
    deliver: (msg: BridgeMessage) => deliver(msg),
    request,
    send,
    unsubscribe,
  };
}

it('parses cc-connect CQ replies without interpreting escaped CQ-looking text', () => {
  expect(parseSegments('[CQ:reply,id=-123]hi &#91;CQ:at,qq=99&#93; &amp;')).toEqual([
    { type: 'reply', data: { id: '-123' } },
    { type: 'text', data: { text: 'hi [CQ:at,qq=99] &' } },
  ]);
  expect(parseSegments('[CQ:at,qq=99]', true)).toEqual([
    { type: 'text', data: { text: '[CQ:at,qq=99]' } },
  ]);
});

it('supports login, group events, native mention segments, CQ replies and get_msg through real WS', async () => {
  const f = await setup();
  expect(await f.request('get_login_info')).toMatchObject({
    status: 'ok',
    retcode: 0,
    data: { user_id: 99 },
  });
  f.deliver(
    incoming({
      message: [
        { type: 'at', data: { qq: '99' } },
        { type: 'text', data: { text: 'hello' } },
      ],
    }),
  );
  await vi.waitFor(() => expect(f.messages.some((m) => m.post_type === 'message')).toBe(true));
  const event = f.messages.find((m) => m.post_type === 'message')!;
  expect(event).toMatchObject({ group_id: 42, user_id: 7, message_type: 'group' });
  const id = Number(event.message_id);
  expect(Number.isInteger(id) && id < 0 && id >= -2147483647).toBe(true);
  expect(
    await f.request('send_group_msg', { group_id: 42, message: `[CQ:reply,id=${id}]response` }),
  ).toMatchObject({ retcode: 0 });
  expect(f.send).toHaveBeenCalledWith(
    { peerType: 'group', targetId: '42' },
    [{ type: 'text', data: { text: 'response' } }],
    expect.objectContaining({ sequence: 91, senderUin: 7 }),
  );
  expect(await f.request('get_msg', { message_id: id })).toMatchObject({
    data: { sender: { user_id: 7 }, group_id: 42 },
  });
  expect(await f.request('get_group_info', { group_id: 42 })).toMatchObject({
    data: { group_name: '合成群' },
  });
});

it('keeps private clientSeq separate from conversation sequence and rejects cross-conversation quotes', async () => {
  const f = await setup();
  f.deliver(incoming({ peerType: 'c2c', targetId: '7', sequence: 23 }));
  await vi.waitFor(() => expect(f.messages.some((m) => m.post_type === 'message')).toBe(true));
  const id = f.messages.find((m) => m.post_type === 'message')!.message_id;
  expect(
    await f.request('send_private_msg', {
      user_id: 7,
      message: [
        { type: 'reply', data: { id } },
        { type: 'text', data: { text: 'reply' } },
      ],
    }),
  ).toMatchObject({ retcode: 0 });
  expect(f.send.mock.calls[0]?.[2]?.sequence).toBe(23);
  expect(
    await f.request('send_private_msg', { user_id: 8, message: `[CQ:reply,id=${id}]no` }),
  ).toMatchObject({ retcode: 1400 });
  expect(
    await f.request('send_private_msg', { user_id: 7, message: '[CQ:reply,id=123]no' }),
  ).toMatchObject({ retcode: 1400 });
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('filters own messages and duplicates, preserves stable IDs on a new instance and closes on stop', async () => {
  const f = await setup();
  f.deliver(incoming({ senderUin: 99 }));
  f.deliver(incoming());
  f.deliver(incoming());
  await vi.waitFor(() =>
    expect(f.messages.filter((m) => m.post_type === 'message')).toHaveLength(1),
  );
  const id = f.messages.find((m) => m.post_type === 'message')!.message_id;
  const next = await setup();
  next.deliver(incoming());
  await vi.waitFor(() => expect(next.messages.some((m) => m.post_type === 'message')).toBe(true));
  expect(next.messages.find((m) => m.post_type === 'message')!.message_id).toBe(id);
  const closed = once(f.ws, 'close');
  f.server.stop();
  await closed;
  expect(f.unsubscribe).toHaveBeenCalledTimes(1);
});

it('returns correlated errors and never reports unsupported actions or rejected sends as successful', async () => {
  const f = await setup();
  expect(await f.request('not_implemented')).toMatchObject({ status: 'failed', retcode: 1404 });
  f.send.mockRejectedValueOnce(new Error('synthetic QQ rejection'));
  expect(await f.request('send_private_msg', { user_id: 7, message: 'hi' })).toMatchObject({
    status: 'failed',
    retcode: 1400,
    message: 'synthetic QQ rejection',
  });
  expect(await f.request('send_group_msg', { group_id: 'not-an-id', message: 'hi' })).toMatchObject(
    { retcode: 1400 },
  );
  expect(
    await f.request('upload_group_file', { group_id: 42, file: 'base64://YQ==', name: 'a.txt' }),
  ).toMatchObject({ retcode: 0 });
  expect(f.send.mock.calls.at(-1)?.[1]).toEqual([
    { type: 'file', data: { file: 'base64://YQ==', name: 'a.txt' } },
  ]);
});

it('rejects unauthenticated websocket upgrades', async () => {
  const f = await setup();
  const ws = new WebSocket(`ws://127.0.0.1:${f.port}`);
  sockets.push(ws);
  const error = await new Promise<Error>((resolve) => ws.once('error', resolve));
  expect(error.message).toContain('401');
});

it('does not retain Base64 attachment bodies in get_msg records', async () => {
  const f = await setup();
  const response = await f.request('upload_group_file', {
    group_id: 42,
    file: `base64://${'YQ=='.repeat(1000)}`,
    name: 'synthetic.txt',
  });
  const id = (response.data as { message_id: number }).message_id;
  const cached = JSON.stringify(await f.request('get_msg', { message_id: id }));
  expect(cached).not.toContain('base64://');
  expect(cached.length).toBeLessThan(1024);
});
