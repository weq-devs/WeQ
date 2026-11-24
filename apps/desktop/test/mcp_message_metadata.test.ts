// @vitest-environment node
import { expect, it, vi } from 'vitest';

const recentContacts = vi.hoisted(() =>
  [
    { chatType: 'KCHATTYPEGROUP', targetUid: '456', targetUin: 0n },
    { chatType: 'KCHATTYPETEMPC2CFROMGROUP', targetUid: 'u_peer', targetUin: 123n },
    { chatType: 'KCHATTYPEGROUPHELPER', targetUid: 'helper', targetUin: 0n },
    { chatType: 'KCHATTYPEC2C', targetUid: '', targetUin: 999n },
  ].map((row) => ({
    msgSeq: 1n,
    sendTime: 1792461600n,
    topTime: 0n,
    tempSourceGroupCode: 0n,
    ...row,
  })),
);
const profileRead = vi.hoisted(() => vi.fn(async () => null));
const cacheRead = vi.hoisted(() => vi.fn(async () => null));
const legacyBefore = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => []));
const localMessagePage = vi.hoisted(() => {
  const message = {
    msgId: 9007199254740993n,
    msgSeq: 2n,
    sendTime: 1792461600n,
    senderUid: 'fixture_sender',
    senderUin: 1n,
    elements: [],
  };
  return vi.fn(async (..._args: unknown[]) => [message]);
});
const profileCache = vi.hoisted(() => ({
  switched: false,
  read: vi.fn(async () => ({ uin: 1n, uid: 'u_self', nick: '合成账号', avatarUrl: '' })),
}));

vi.mock('../src/main/context/app_context', () => {
  const context = {
    account: { context: { uin: '1' } },
    services: {
      gapHistory: { findByMsgId: cacheRead },
      profile: {
        getSelfProfile: profileRead,
        getCachedSelfProfile: profileCache.read,
        nicksByUids: async () => ({}),
      },
      recentContacts: { getRecentContact: async () => recentContacts },
      msgs: {
        getGroupMessageById: async () => ({
          msgId: 9007199254740993n,
          msgSeq: 2n,
          sendTime: 1792461600n,
          senderUid: 'fixture_sender',
          senderUin: 1n,
          elements: [],
        }),
        getLocalMessagePage: localMessagePage,
        getGroupBefore: legacyBefore,
      },
    },
  };
  return {
    getAppContext: () => (profileCache.switched ? { ...context, services: {} } : context),
  };
});

it('聊天翻页把同序号边界的原始 ID 与时间传回存储层', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_messages')!;
  const args = { kind: 'group', conv: '123', limit: 1, includeIds: true };
  const [message] = await localMessagePage();
  const next = { ...message!, msgId: 9007199254740992n };
  localMessagePage.mockResolvedValueOnce([message!, next]).mockResolvedValueOnce([next]);
  const first = (await tool.run({ ...args, before: '' })) as { nextBefore: string };
  expect(first.nextBefore).toBe('v1:2:1792461600:9007199254740993');
  const page = await tool.run({ ...args, before: first.nextBefore });
  expect(localMessagePage).toHaveBeenLastCalledWith('group', '123', 2, {
    msgId: 9007199254740993n,
    msgSeq: 2n,
    sendTime: 1792461600n,
  });
  expect(page).toMatchObject({ hasMore: false, messages: [{ msgId: '9007199254740992' }] });
  expect(await tool.run({ ...args, before: '2' })).toMatchObject({ hasMore: false, messages: [] });
  expect(legacyBefore).toHaveBeenLastCalledWith('123', 2n, 2);
});

import { AI_TOOLS } from '../src/main/mcp/tools';

it('lists directly readable conversation keys without guessing for aggregate or missing targets', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'list_conversations')!;
  const result = (await tool.run({ limit: 10 })) as object[];
  expect(result).toHaveLength(4);
  expect(result[0]).toMatchObject({ conv: '456', kind: 'group', targetUid: '456', targetUin: '0' });
  expect(result[1]).toMatchObject({ conv: 'u_peer', kind: 'c2c', targetUid: 'u_peer' });
  expect(result[2]).not.toHaveProperty('kind');
  expect(result[3]).not.toHaveProperty('conv');
});

it('returns exact source time and sender identity with message IDs without SQL', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_messages')!;
  const args = { kind: 'group', conv: '123', limit: 100, before: '' };
  const result = (await tool.run({ ...args, includeIds: true })) as { messages: object[] };
  expect(result.messages[0]).toMatchObject({
    msgId: '9007199254740993',
    sendTime: '1792461600',
    senderUid: 'fixture_sender',
    mine: true,
  });
  const compact = (await tool.run({ ...args, includeIds: false })) as { messages: object[] };
  expect(compact.messages[0]).not.toHaveProperty('sendTime');
  expect(compact.messages[0]).not.toHaveProperty('senderUid');
  expect(profileRead).not.toHaveBeenCalled();
});

it('returns the same raw time in read-only message details', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_message_details')!;
  expect(
    await tool.run({
      kind: 'group',
      conv: '123',
      msgId: '9007199254740993',
      includePayload: false,
      includeMedia: false,
    }),
  ).toMatchObject({
    found: true,
    kind: 'group',
    conv: '123',
    msgId: '9007199254740993',
    sendTime: '1792461600',
    senderUid: 'fixture_sender',
    mine: true,
  });
  expect(profileRead).not.toHaveBeenCalled();
  expect(cacheRead).toHaveBeenCalledWith('9007199254740993', { recalledOnly: true });
});

it('本人资料返回原字段，切换账号后拒绝旧读取结果', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_self_profile')!;
  expect(await tool.run({})).toMatchObject({ uin: '1', uid: 'u_self', nick: '合成账号' });
  profileCache.read.mockImplementationOnce(async () => {
    profileCache.switched = true;
    return { uin: 1n, uid: 'u_self', nick: '旧账号', avatarUrl: '' };
  });
  try {
    await expect(tool.run({})).rejects.toThrow('账号或数据源已切换');
  } finally {
    profileCache.switched = false;
  }
});
