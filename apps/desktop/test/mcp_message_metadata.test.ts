// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import type { RenderElement } from '@weq/service';

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
beforeEach(() => profileRead.mockClear());
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
const detailRows = vi.hoisted(() => {
  const host = {
    msgId: 9007199254740993n,
    msgSeq: 2n,
    sendTime: 1792461600n,
    senderUid: 'fixture_sender',
    senderUin: 1n,
    elements: [] as RenderElement[],
  };
  const groupOriginal = {
    ...host,
    msgId: 9007199254740995n,
    msgSeq: 1n,
    sendTime: 1792461500n,
    senderUid: 'u_original',
    senderUin: 2n,
    targetGroupCode: '123',
  };
  const c2cOriginal = {
    ...host,
    msgId: groupOriginal.msgId,
    msgSeq: 120n,
    clientSeq: 7n,
    sendTime: groupOriginal.sendTime,
    senderUid: groupOriginal.senderUid,
    senderUin: groupOriginal.senderUin,
    targetUid: 'u_peer',
  };
  return {
    host,
    groupOriginal,
    c2cOriginal,
    groupById: vi.fn(async (_conv: string, id: bigint) => {
      if (id === host.msgId) return { ...host, targetGroupCode: '123' };
      return id === groupOriginal.msgId ? groupOriginal : null;
    }),
    c2cById: vi.fn(async () => ({ ...host, targetUid: 'u_peer' })),
    groupBySeq: vi.fn(async (..._args: unknown[]) => [groupOriginal]),
    c2cBySeq: vi.fn(async (..._args: unknown[]) => [c2cOriginal]),
    resolveC2cSeq: vi.fn(async (..._args: unknown[]) => 120n),
  };
});
const browseGroup = vi.hoisted(() => vi.fn());
const dataline = vi.hoisted(() => ({
  hasTable: vi.fn(async () => true),
  listNewestHistory: vi.fn(),
}));

vi.mock('../src/main/context/app_context', async () => {
  const { MsgService } = await import('@weq/service');
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
      groupInfo: { listAllGroups: async () => [] },
      msgs: Object.assign(
        new MsgService({
          groupMsgs: { listBySeqsInPartition: detailRows.groupBySeq, browse: browseGroup },
          c2cMsgs: {
            browse: async () => [],
            listBySeqsInPartition: detailRows.c2cBySeq,
            resolveReplySeq: detailRows.resolveC2cSeq,
          },
          datalineMsgs: dataline,
          uidMap: { sortNoByUid: (uid: string) => (uid === 'u_peer' ? 55n : undefined) },
          msgDbPath: 'fixture',
        } as never),
        {
          getGroupMessageById: detailRows.groupById,
          getC2cMessageById: detailRows.c2cById,
          getLocalMessagePage: localMessagePage,
          getGroupBefore: legacyBefore,
        },
      ),
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

it('按北京时间读取历史日期并在同秒消息之间继续翻页', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_messages_by_date')!;
  const start = Date.parse('2020-06-01T00:00:00+08:00') / 1000;
  const row = { ...detailRows.host, sendTime: BigInt(start), targetGroupCode: '123' };
  const older = { ...row, msgId: row.msgId - 1n };
  browseGroup.mockResolvedValueOnce([
    { rowId: '9007199254740993', message: row },
    { rowId: '9007199254740992', message: older },
  ]);
  browseGroup.mockResolvedValueOnce([{ rowId: '9007199254740992', message: older }]);
  const args = { kind: 'group', conv: '123', date: '2020-06-01', limit: 1, includeIds: true };
  const first = (await tool.run({ ...args, before: '' })) as { nextBefore: string };
  expect(first).toMatchObject({ hasMore: true, messages: [{ msgId: String(row.msgId) }] });
  expect(browseGroup).toHaveBeenLastCalledWith('123', { start, end: start + 86399 }, undefined, 2);
  const page = await tool.run({ ...args, before: first.nextBefore });
  expect(browseGroup).toHaveBeenLastCalledWith(
    '123',
    { start, end: start + 86399 },
    { time: start, rowId: '9007199254740993' },
    2,
  );
  expect(page).toMatchObject({ hasMore: false, messages: [{ msgId: String(older.msgId) }] });
  expect(page).not.toHaveProperty('nextBefore');
  await expect(tool.run({ ...args, date: '2020-06-02', before: first.nextBefore })).rejects.toThrow(
    '游标无效',
  );
});

import { AI_TOOLS } from '../src/main/mcp/tools';
import { mentionAllKind } from '../src/main/mcp/msg_rich';

it('distinguishes native group-wide reminders from text and messages with a body', () => {
  const at: RenderElement = { type: 'at', data: { atTargetUid: 'all', textContent: '@全体成员' } };
  const text = (textContent: string): RenderElement => ({ type: 'text', data: { textContent } });
  expect(mentionAllKind([text('@全体成员')])).toBeUndefined();
  expect(mentionAllKind([{ ...at, data: { ...at.data, atTargetUid: 'u_peer' } }])).toBeUndefined();
  expect(mentionAllKind([at, text('  '), { type: 'reply', data: {} }])).toBe('only');
  expect(mentionAllKind([at, text('报名截至周五')])).toBe('with_content');
});

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

it('历史摘要包含之后又收到新消息的会话，并报告实际覆盖范围', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'get_daily_digest')!;
  const start = BigInt(Date.parse('2020-06-01T00:00:00+08:00') / 1000);
  browseGroup.mockResolvedValueOnce([
    { rowId: '1', message: { ...detailRows.host, sendTime: start, targetGroupCode: '456' } },
  ]);
  expect(await tool.run({ date: '2020-06-01' })).toMatchObject({
    totals: { conversationsTouched: 1, friendsIChattedWith: 0 },
    groups: [{ groupCode: '456', totalCount: 1 }],
    coverage: { conversationsScanned: 2, messagesLimited: false },
  });
});

it('可从本地消息发现已离开最近列表的数据线设备', async () => {
  const tool = AI_TOOLS.find((item) => item.name === 'list_dataline_conversations')!;
  dataline.listNewestHistory.mockImplementation(async ({ uid }: { uid: string }) =>
    uid === 'u_Wcc5rknRRqRO8y5gxMD6sA' ? [detailRows.host] : [],
  );
  expect(await tool.run({ limit: 1 })).toMatchObject({
    count: 1,
    sessions: [{ device: '我的手机', conv: 'u_Wcc5rknRRqRO8y5gxMD6sA', lastSeq: '2' }],
  });
  dataline.hasTable.mockResolvedValueOnce(false);
  expect(await tool.run({ limit: 1 })).toMatchObject({ count: 0, sessions: [] });
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

function quotedReply(origMsgSeq: number, origMsgIndex = 0): RenderElement {
  return {
    type: 'reply',
    data: {
      elementId: 1n,
      isSender: false,
      subType: 0,
      origMsgId: 72057594037927937n,
      origMsgSeq,
      origMsgIndex,
      origMsgTime: 1792461500,
      origSenderUid: 'u_original',
      origSenderUin: 2,
      origElements: [{ type: 'text', data: { textContent: '原引文' } }],
    },
  };
}

const readReplyDetail = (kind: 'group' | 'c2c', conv: string, includePayload = true) =>
  AI_TOOLS.find((item) => item.name === 'get_message_details')!.run({
    kind,
    conv,
    msgId: String(detailRows.host.msgId),
    includePayload,
    includeMedia: false,
  });

it('resolves a group reply to an exact 64-bit message ID that can be read back', async () => {
  detailRows.groupById.mockResolvedValueOnce({
    ...detailRows.host,
    targetGroupCode: '123',
    elements: [quotedReply(1)],
  });
  const result = await readReplyDetail('group', '123');
  const original = { msgId: '9007199254740995', msgSeq: '1', sendTime: '1792461500' };
  expect(result).toMatchObject({
    elements: [{ payload: { origMsgId: '72057594037927937', origMsgSeq: '1', original } }],
  });
  expect(detailRows.groupBySeq).toHaveBeenLastCalledWith('123', [1n]);
  const tool = AI_TOOLS.find((item) => item.name === 'get_message_details')!;
  expect(
    await tool.run({
      kind: 'group',
      conv: '123',
      msgId: original.msgId,
      includePayload: false,
      includeMedia: false,
    }),
  ).toMatchObject({ found: true, ...original });
});

it('keeps only the preview on ambiguous or mismatched matches and skips lookup without payload', async () => {
  const host = { ...detailRows.host, targetGroupCode: '123', elements: [quotedReply(1)] };
  detailRows.groupById.mockResolvedValueOnce(host);
  detailRows.groupBySeq.mockResolvedValueOnce([
    detailRows.groupOriginal,
    { ...detailRows.groupOriginal, msgId: 42n },
  ]);
  const ambiguous = await readReplyDetail('group', '123');
  expect(ambiguous).toMatchObject({ elements: [{ payload: { quoteText: '原引文' } }] });
  expect(ambiguous).not.toHaveProperty('elements.0.payload.original');

  detailRows.groupById.mockResolvedValueOnce(host);
  detailRows.groupBySeq.mockResolvedValueOnce([{ ...detailRows.groupOriginal, senderUin: 3n }]);
  expect(await readReplyDetail('group', '123')).not.toHaveProperty('elements.0.payload.original');

  const lookups = detailRows.groupBySeq.mock.calls.length;
  detailRows.groupById.mockResolvedValueOnce(host);
  expect(await readReplyDetail('group', '123', false)).not.toHaveProperty('elements.0.payload');
  detailRows.groupById.mockResolvedValueOnce(host);
  expect(await readReplyDetail('group', '999')).toMatchObject({ found: false });
  expect(detailRows.groupBySeq).toHaveBeenCalledTimes(lookups);
});

it('uses the conversation sequence or resolves the sender-local sequence for private replies', async () => {
  const host = { ...detailRows.host, targetUid: 'u_peer', msgSeq: 125n };
  const expected = { elements: [{ payload: { original: { msgSeq: '120' } } }] };
  const resolutions = detailRows.resolveC2cSeq.mock.calls.length;
  detailRows.c2cById.mockResolvedValueOnce({ ...host, elements: [quotedReply(7, 120)] });
  expect(await readReplyDetail('c2c', 'u_peer')).toMatchObject(expected);
  expect(detailRows.resolveC2cSeq).toHaveBeenCalledTimes(resolutions);

  detailRows.c2cById.mockResolvedValueOnce({ ...host, elements: [quotedReply(7)] });
  expect(await readReplyDetail('c2c', 'u_peer')).toMatchObject(expected);
  expect(detailRows.resolveC2cSeq).toHaveBeenLastCalledWith({ sortNo: 55n }, 7n, 2n, 1792461500n);
  expect(detailRows.c2cBySeq).toHaveBeenLastCalledWith({ sortNo: 55n }, [120n]);
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
