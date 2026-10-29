// @vitest-environment node
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { NapcatAdapter, SnowLumaAdapter } from '../../../packages/bot/src/adapter/onebot';
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

async function setup(path = '/') {
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
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
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
    backend,
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

it('get_msg 回查完整正文，撤回和表情回应共享同一定位', async () => {
  const f = await setup();
  const message = incoming({
    message: [{ type: 'text', data: { text: 'x'.repeat(20000) } }],
    location: { conv: '42', msgId: '9007199254740993123', msgSeq: 91, clientSeq: 0, random: 9 },
  });
  f.backend.readMessage = vi.fn().mockResolvedValue(message);
  f.backend.recall = vi.fn();
  f.backend.reaction = vi.fn();
  const id = f.server.register(message);
  const result = await f.request('get_msg', { message_id: id });
  expect(result).toMatchObject({ retcode: 0, data: { message: message.message } });
  expect(await f.request('delete_msg', { message_id: id })).toMatchObject({
    retcode: 0,
    data: null,
  });
  expect(f.backend.recall).toHaveBeenCalledWith(message);
  await f.request('set_msg_emoji_like', { message_id: id, emoji_id: '76', set: 'false' });
  expect(f.backend.reaction).toHaveBeenCalledWith(message, '76', false);
});

it('原消息不可回查时不返回截断正文或执行撤回', async () => {
  const f = await setup();
  f.backend.readMessage = vi.fn().mockResolvedValue(null);
  f.backend.recall = vi.fn();
  const id = f.server.register(
    incoming({ location: { conv: '42', msgId: '1', msgSeq: 91, clientSeq: 0, random: 9 } }),
  );
  expect(await f.request('get_msg', { message_id: id })).toMatchObject({ retcode: 1404 });
  expect(await f.request('delete_msg', { message_id: id })).toMatchObject({ retcode: 1404 });
  expect(f.backend.recall).not.toHaveBeenCalled();
});

it('标准 send_msg、单段对象和字符串 false 通过真实 WS 生效', async () => {
  const f = await setup();
  expect(
    await f.request('send_msg', {
      group_id: 42,
      message: { type: 'text', data: { text: '单段' } },
    }),
  ).toMatchObject({ retcode: 0 });
  expect(f.send).toHaveBeenLastCalledWith(
    { peerType: 'group', targetId: '42' },
    [{ type: 'text', data: { text: '单段' } }],
    undefined,
  );
  await f.request('send_msg', { group_id: 42, message: '[CQ:at,qq=99]', auto_escape: 'false' });
  expect(f.send.mock.calls.at(-1)?.[1]).toEqual([{ type: 'at', data: { qq: '99' } }]);
});

it('/api 不推消息或生命周期，仍能收发 action', async () => {
  const f = await setup('/api');
  f.deliver(incoming());
  expect(await f.request('get_login_info')).toMatchObject({ retcode: 0 });
  expect(f.messages.some((message) => message.post_type)).toBe(false);
});

it.each([NapcatAdapter, SnowLumaAdapter])(
  '已有独立 OneBot 客户端 %s 可收消息、发送并调用扩展 action',
  async (Adapter) => {
    const f = await setup();
    f.backend.action = vi
      .fn()
      .mockResolvedValue([{ user_id: 7, nickname: '合成好友', remark: '' }]);
    const adapter = new Adapter({
      type: Adapter === NapcatAdapter ? 'napcat' : 'snowluma',
      wsUrl: `ws://127.0.0.1:${f.port}`,
      token: 'synthetic-token',
    });
    try {
      await adapter.connect();
      const events: unknown[] = [];
      adapter.onEvent((event) => events.push(event));
      f.deliver(incoming());
      await vi.waitFor(() =>
        expect(
          events.some((event) => (event as { post_type?: string }).post_type === 'message'),
        ).toBe(true),
      );
      expect(await adapter.callAction('get_friend_list', {})).toMatchObject([{ user_id: 7 }]);
      expect(
        await adapter.sendMessage({ chatType: 'group', peerId: '42' }, [
          { type: 'text', data: { text: '客户端合成回复' } },
        ]),
      ).toHaveProperty('messageId');
    } finally {
      adapter.close();
    }
  },
);

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
  ).toMatchObject({ retcode: 1404 });
  expect(f.send).toHaveBeenCalledTimes(1);
});

it('登记但不上报自身消息，过滤重复上报，停止时断开连接', async () => {
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
  expect(Number.isInteger(id)).toBe(true);
  expect(Number(next.messages.find((m) => m.post_type === 'message')!.message_id)).toBeLessThan(0);
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
