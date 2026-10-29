// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { compareMessageOrder } from '@weq/codec';
import type { GapFetchedMessage } from '@weq/service';
import { createHistory } from '../src/main/onebot/history';
import { createForward } from '../src/main/onebot/forward';
import type { ActionServices, ActionSession } from '../src/main/onebot/actions';
import type { BridgeMessage } from '../src/main/onebot/server';
import { MessageRegistry } from '../src/main/onebot/registry';

const row = (msgId: string, seq: number, time = 100): GapFetchedMessage => ({
  kind: 'group',
  conv: '42',
  msgId,
  msgSeq: String(seq),
  msgRandom: String(BigInt(msgId) % 4294967295n),
  senderUid: 'u_peer',
  senderUin: '7',
  sendTime: String(time),
  elements: [{ type: 'text', data: { textContent: msgId } }],
  sourceFormat: 'protocol',
  ntSeqVerified: true,
});
function setup() {
  let active = true;
  const requireActive = () => {
    if (!active) throw Error('账号已切换');
  };
  const registry = new MessageRegistry();
  const records = new Map<number, BridgeMessage>();
  const server = {
    register(message: BridgeMessage) {
      const id = registry.remember(message);
      records.set(id, message);
      return id;
    },
    async resolve(id: number) {
      const message = records.get(id);
      if (!message) throw Error('不存在');
      return message;
    },
    messageData(message: BridgeMessage) {
      return {
        message_id: this.register(message),
        message: message.message,
        raw_id: message.location?.msgId,
      };
    },
    forwardMessage: (id: string) => registry.forward(id),
    prepare: () => 'pending-forward',
  };
  const getHistoryPage = vi.fn().mockResolvedValue([]);
  const cachedTimeline = vi.fn().mockResolvedValue([]);
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    messages: [],
    nextStartSeq: null,
    fetched: 0,
    networkRequested: true,
  });
  const sendForward = vi.fn().mockResolvedValue({
    ok: true,
    resId: 'res-synthetic',
    card: {
      ok: true,
      groupSequence: 91,
      privateSequence: 800,
      clientSequence: 23,
      random: 19,
      timestamp: 100,
    },
    uid: 'u_peer',
  });
  const fetchRemote = vi.fn().mockResolvedValue([
    {
      senderUin: '7',
      senderUid: 'u_peer',
      sendNick: '合成成员',
      sendTime: '100',
      elements: row('1', 1).elements,
    },
  ]);
  const services = {
    msgs: { getHistoryPage },
    gapHistory: { cachedTimeline, fetch },
    messageSend: { sendForward },
    forwardMsgs: {
      fetchRemote,
      getGroupForward: vi.fn().mockResolvedValue([]),
      getC2cForward: vi.fn().mockResolvedValue([]),
    },
  };
  const session = {
    context: { uin: '99' },
    uidMap: { uidByUin: () => 'u_peer' },
  } as unknown as ActionSession;
  const project = async (item: GapFetchedMessage): Promise<BridgeMessage> => ({
    key: item.msgId,
    peerType: item.kind,
    targetId: item.kind === 'group' ? item.conv : '7',
    senderUin: Number(item.senderUin),
    nickname: '合成成员',
    time: Number(item.sendTime),
    sequence: Number(item.kind === 'group' ? item.msgSeq : item.clientSeq),
    location: {
      conv: item.conv,
      msgId: item.msgId,
      msgSeq: Number(item.msgSeq),
      clientSeq: Number(item.clientSeq ?? 0),
      random: Number(item.msgRandom ?? 0),
    },
    message: [{ type: 'text', data: { text: item.msgId } }],
  });
  const history = createHistory(
    services as unknown as ActionServices,
    session,
    requireActive,
    () => server,
    project,
  );
  const convert = vi.fn().mockImplementation(async (segments) =>
    segments.map((segment: { data: { text: string } }) => ({
      kind: 'text',
      textContent: segment.data.text,
    })),
  );
  const forward = createForward(
    services as unknown as ActionServices,
    session,
    requireActive,
    () => server,
    async () => [{ type: 'text', data: { text: '合成内容' } }],
    convert,
  );
  return {
    services,
    server,
    registry,
    history,
    forward,
    project,
    getHistoryPage,
    cachedTimeline,
    fetch,
    sendForward,
    fetchRemote,
    convert,
    deactivate: () => {
      active = false;
    },
  };
}

it('本地与缓存合并，同序号不同 ID 不丢失，下一页用完整身份游标', async () => {
  const f = setup();
  const rows = [row('9007199254740993001', 12), row('9007199254740993002', 12)];
  f.cachedTimeline.mockImplementation(
    async (_kind, _conv, _min, _max, _count, descending, cursor) =>
      rows.filter(
        (item) => !cursor || compareMessageOrder(item, cursor) * (descending ? -1 : 1) > 0,
      ),
  );
  const first = await f.history('group', { group_id: 42, count: 1 });
  expect(first.messages).toMatchObject([{ raw_id: rows[1]!.msgId }]);
  const second = await f.history('group', {
    group_id: 42,
    count: 1,
    message_seq: first.next_message_seq,
  });
  expect(second.messages).toMatchObject([{ raw_id: rows[0]!.msgId }]);
  expect(second.next_message_seq).not.toBe(first.next_message_seq);
  expect(f.getHistoryPage.mock.calls.at(-1)?.[2].cursor.msgId).toBe(9007199254740993002n);
});

it('私聊历史锚点使用 msgSeq 而不是 clientSeq，跨会话锚点拒绝', async () => {
  const f = setup();
  const message = await f.project({
    ...row('11', 800),
    kind: 'c2c',
    conv: 'u_peer',
    clientSeq: '23',
  });
  const id = f.server.register(message);
  await f.history('c2c', { user_id: 7, message_seq: id });
  expect(f.getHistoryPage.mock.calls[0]?.[2].cursor.msgSeq).toBe(800n);
  await expect(f.history('group', { group_id: 42, message_seq: id })).rejects.toThrow('其他会话');
});

it('同消息在本地和漫游使用不同 ID 时，不把锚点重复返回', async () => {
  const f = setup();
  const anchor = await f.project(row('9007199254740993001', 12));
  anchor.location!.random = 91;
  const id = f.server.register(anchor);
  f.cachedTimeline.mockResolvedValue([{ ...row('91', 12), msgRandom: '91' }, row('10', 11)]);
  expect((await f.history('group', { group_id: 42, message_seq: id })).messages).toMatchObject([
    { raw_id: '10' },
  ]);
});

it('空漫游窗口继续按 nextStartSeq 前进，默认查询不联网', async () => {
  const f = setup();
  await f.history('group', { group_id: 42 });
  expect(f.fetch).not.toHaveBeenCalled();
  f.fetch
    .mockResolvedValueOnce({
      ok: true,
      messages: [],
      nextStartSeq: 31,
      fetched: 0,
      networkRequested: true,
    })
    .mockResolvedValueOnce({
      ok: true,
      messages: [],
      nextStartSeq: null,
      fetched: 0,
      networkRequested: true,
    });
  expect(
    await f.history('group', { group_id: 42, count: 60, end_seq: 60, fetch_remote: true }),
  ).toMatchObject({ network_requested: true });
  expect(f.fetch.mock.calls.map((call) => call[2])).toEqual([1, 31]);
});

it('历史查询期间切号不发布旧结果', async () => {
  const f = setup();
  f.getHistoryPage.mockImplementationOnce(async () => {
    f.deactivate();
    return [];
  });
  await expect(f.history('group', { group_id: 42 })).rejects.toThrow('切换');
  expect(f.cachedTimeline).not.toHaveBeenCalled();
});

it('自定义、ID 引用和嵌套节点通过同一转换路径发送', async () => {
  const f = setup();
  const original = await f.project(row('123', 12));
  const id = f.server.register(original);
  const result = await f.forward('send_group_forward_msg', {
    group_id: 42,
    messages: [
      { type: 'node', data: { id } },
      {
        type: 'node',
        data: {
          user_id: '7',
          nickname: '嵌套',
          content: [{ type: 'node', data: { user_id: '8', nickname: '内层', content: '正文' } }],
        },
      },
    ],
  });
  expect(result).toMatchObject({ forward_id: 'res-synthetic' });
  expect(f.sendForward.mock.calls[0]?.[0].nodes).toMatchObject([
    { userUin: 7, elements: [{ kind: 'text', textContent: '123' }] },
    {
      userUin: 7,
      innerForward: [{ userUin: 8, elements: [{ kind: 'text', textContent: '正文' }] }],
    },
  ]);
});

it('获取转发返回标准 node 结构，私聊发送登记两种序号', async () => {
  const f = setup();
  expect(await f.forward('get_forward_msg', { id: 'resource' })).toMatchObject({
    message: [
      { type: 'node', data: { user_id: '7', nickname: '合成成员', content: [{ type: 'text' }] } },
    ],
  });
  const result = await f.forward('send_private_forward_msg', {
    user_id: 7,
    messages: [{ type: 'node', data: { user_id: '7', nickname: '成员', content: '内容' } }],
  });
  expect(f.registry.get(Number(result.message_id))).toMatchObject({
    location: { msgSeq: 800, clientSeq: 23 },
  });
});

it('本地已缓存的嵌套转发直接展开，不重复联网', async () => {
  const f = setup();
  const owner = await f.project(row('99', 12));
  f.server.register({ ...owner, forwardId: 'local-res' });
  f.services.forwardMsgs.getGroupForward.mockResolvedValue([
    { msgType: 8, senderUin: 7, subMsgs: [{ senderUin: 8, sendNick: '内层成员', elements: [] }] },
  ]);
  expect(await f.forward('get_forward_msg', { id: 'local-res' })).toMatchObject({
    message: [
      {
        type: 'node',
        data: { content: [{ type: 'node', data: { user_id: '8', nickname: '内层成员' } }] },
      },
    ],
  });
  expect(f.fetchRemote).not.toHaveBeenCalled();
});

it('节点数量超限整体失败，不先发送部分节点', async () => {
  const f = setup();
  await expect(
    f.forward('send_group_forward_msg', {
      group_id: 42,
      messages: Array.from({ length: 201 }, () => ({
        type: 'node',
        data: { content: '合成节点' },
      })),
    }),
  ).rejects.toThrow('200');
  expect(f.sendForward).not.toHaveBeenCalled();
});

it('节点转换期间切号或遇到非法节点均不发布消息', async () => {
  const f = setup();
  await expect(
    f.forward('send_group_forward_msg', {
      group_id: 42,
      messages: [{ type: 'text', data: { text: '不是节点' } }],
    }),
  ).rejects.toThrow('node');
  f.convert.mockImplementationOnce(async () => {
    f.deactivate();
    return [{ kind: 'text', textContent: 'x' }];
  });
  await expect(
    f.forward('send_group_forward_msg', {
      group_id: 42,
      messages: [{ type: 'node', data: { content: 'x' } }],
    }),
  ).rejects.toThrow('切换');
  expect(f.sendForward).not.toHaveBeenCalled();
});
