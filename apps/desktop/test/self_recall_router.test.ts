// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { antiRecallRouter } from '../src/main/ipc/routers/anti_recall';
import { dbEventBus } from '../src/main/context/app_context';

const fixture = vi.hoisted(() => ({
  protects: vi.fn(),
  preserve: vi.fn(),
  send: vi.fn(),
  cachedRecalls: vi.fn(),
  nativeRecalls: vi.fn(),
  recallRefs: vi.fn(),
  deletedRefs: vi.fn(),
  recordBodies: vi.fn(),
  cachedDeleted: vi.fn(),
  summaries: vi.fn(),
  logs: vi.fn(),
  switched: false,
}));
vi.mock('../src/main/context/app_context', async () => {
  const { EventEmitter } = await import('node:events');
  const account = { context: { uin: '10001' } };
  const services = {
    accountConfig: { getRecord: () => ({ configId: 'source-a', qqOnline: true, qqPid: 42 }) },
    groupModeration: { recallMessage: fixture.send },
    antiRecall: {
      protects: fixture.protects,
      listRecallConversations: fixture.summaries,
      listRecalls: fixture.logs,
    },
    gapHistory: {
      withSelfRecallProtection: fixture.preserve,
      cachedRecalls: fixture.cachedRecalls,
      cachedDeleted: fixture.cachedDeleted,
    },
    msgs: {
      getRecalledMessages: fixture.nativeRecalls,
      listRecallRefs: fixture.recallRefs,
      listDeletedRefs: fixture.deletedRefs,
      getDeletedMsgIds: () => [],
      readHistoryRecordBodies: fixture.recordBodies,
    },
  };
  const bootstrap = () => ({
    ocrModels: { listByKind: () => [] },
    userConfig: {
      getSettings: () => ({ autoAttachQq: true, ocr: { prefilterEnabled: false } }),
      getLocalModelId: () => null,
    },
  });
  return {
    accountEventBus: new EventEmitter(),
    dbEventBus: new EventEmitter(),
    getAppContext: () => ({
      account: fixture.switched ? null : account,
      services,
      bootstrap: bootstrap(),
    }),
    requireBootstrap: bootstrap,
  };
});
const params = {
  kind: 'c2c' as const,
  conv: 'u_peer',
  sequence: 42,
  random: 1234,
  clientSequence: 3,
  timestamp: 1700000000,
};
const recalled = {
  ...params,
  msgId: '1234',
  msgSeq: '42',
  msgRandom: '1234',
  sourceFormat: 'protocol' as const,
  localSent: true,
  ntSeqVerified: true,
  senderUid: 'u_self',
  senderUin: '10001',
  sendTime: '1700000000',
  elements: [],
  recall: { revokeUid: 'u_self', sameSender: true, recallTs: 1700000010 },
};

beforeEach(() => {
  vi.resetAllMocks();
  dbEventBus.removeAllListeners();
  fixture.switched = false;
  fixture.protects.mockReturnValue(true);
  fixture.send.mockResolvedValue(undefined);
  fixture.preserve.mockImplementation(async (_params, send: () => Promise<void>) => {
    await send();
    return recalled;
  });
  fixture.cachedRecalls.mockResolvedValue([recalled]);
  fixture.nativeRecalls.mockResolvedValue([]);
  fixture.recallRefs.mockResolvedValue([]);
  fixture.deletedRefs.mockResolvedValue([]);
  fixture.recordBodies.mockResolvedValue([]);
  fixture.cachedDeleted.mockResolvedValue([]);
  fixture.summaries.mockResolvedValue([]);
  fixture.logs.mockResolvedValue([]);
});

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
const nativeRecord = (id: bigint, type: 'recalled' | 'deleted') => ({
  ...recalled,
  msgId: id,
  msgSeq: 33n,
  msgRandom: id,
  targetUid: params.conv,
  sendTime: 1700000000n,
  recall: type === 'recalled' ? { ...recalled.recall, recallTs: 1700000001 } : undefined,
  deletedKind: type === 'deleted' ? 'qq' : undefined,
});

it('撤回缓存与原库按撤回时间合并，跨页替代旧原库副本且不取无关原文', async () => {
  fixture.recallRefs.mockResolvedValue(
    [
      { ...recalled, msgId: '111', recall: { ...recalled.recall, recallTs: 1700000005 } },
      {
        ...recalled,
        msgId: '222',
        msgSeq: '33',
        msgRandom: '222',
        recall: { ...recalled.recall, recallTs: 1700000001 },
      },
    ].map(({ sourceFormat: _sourceFormat, localSent: _localSent, ...row }) => row),
  );
  fixture.recordBodies.mockImplementation(async (_kind, _conv, ids: bigint[]) =>
    ids.map((id) => nativeRecord(id, 'recalled')),
  );
  const caller = accountRouter.createCaller({});
  const input = { ...params, ...binding, record: 'recalled' as const, limit: 1 };
  const first = await caller.messageHistoryPage(input);
  expect(first.rows.map((row) => row.msgId)).toEqual([recalled.msgId]);
  expect(first.nextBefore).not.toBeNull();
  const second = await caller.messageHistoryPage({ ...input, before: first.nextBefore! });
  expect(second.rows.map((row) => row.msgId)).toEqual(['222']);
  expect(second.nextBefore).toBeNull();
  expect(fixture.recordBodies.mock.calls.map((call) => call[2])).toEqual([[], [222n]]);
});

it('删除记录同一发送时间跨原库与缓存翻页，不漏同时间的两条消息', async () => {
  fixture.deletedRefs
    .mockResolvedValueOnce([{ msgId: '222', sendTime: recalled.sendTime }])
    .mockResolvedValue([]);
  fixture.cachedDeleted.mockResolvedValue([recalled]);
  fixture.recordBodies.mockImplementation(async (_kind, _conv, ids: bigint[]) =>
    ids.map((id) => nativeRecord(id, 'deleted')),
  );
  const caller = accountRouter.createCaller({});
  const input = { ...params, ...binding, record: 'deleted' as const, limit: 1 };
  const first = await caller.messageHistoryPage(input);
  expect(first.rows.map((row) => [row.msgId, row.deletedKind])).toEqual([['222', 'qq']]);
  const second = await caller.messageHistoryPage({ ...input, before: first.nextBefore! });
  expect(second.rows.map((row) => [row.msgId, row.deletedKind])).toEqual([[recalled.msgId, 'weq']]);
  expect(second.nextBefore).toBeNull();
});

describe('自撤缓存保护 IPC', () => {
  it('使用当前保护范围，保存后推送原账号时间线', async () => {
    const changed = vi.fn();
    dbEventBus.on('roaming', changed);
    await expect(accountRouter.createCaller({}).recallMessage(params)).resolves.toEqual({
      ok: true,
    });
    expect(fixture.protects).toHaveBeenCalledWith(params.kind, params.conv);
    expect(fixture.send).toHaveBeenCalledWith(params);
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ messages: [recalled] }));
  });
  it('总开关关闭或会话未保护时，仅发原始撤回请求', async () => {
    fixture.protects.mockReturnValue(false);
    await accountRouter.createCaller({}).recallMessage(params);
    expect(fixture.send).toHaveBeenCalledOnce();
    expect(fixture.preserve).not.toHaveBeenCalled();
  });
  it('在途切号不会把缓存变更广播到新账号', async () => {
    const changed = vi.fn();
    dbEventBus.on('roaming', changed);
    fixture.send.mockImplementation(async () => {
      fixture.switched = true;
    });
    await accountRouter.createCaller({}).recallMessage(params);
    expect(changed).not.toHaveBeenCalled();
  });
  it('读取缓存期间切号时，不再发送撤回请求', async () => {
    fixture.preserve.mockImplementation(async (_params, send: () => Promise<void>) => {
      fixture.switched = true;
      await send();
    });
    await expect(accountRouter.createCaller({}).recallMessage(params)).rejects.toThrow(
      '账号或数据源已切换',
    );
    expect(fixture.send).not.toHaveBeenCalled();
  });
  it('缓存原文进入撤回列表与目录', async () => {
    const messages = await accountRouter.createCaller({}).recalledMessages(params);
    expect(messages).toMatchObject([
      { msgId: recalled.msgId, source: 'roaming', recall: recalled.recall },
    ]);
    expect(await antiRecallRouter.createCaller({}).listRecallConversations()).toEqual([
      { kind: 'c2c', conv: 'u_peer', count: 1, lastTs: recalled.recall.recallTs },
    ]);
  });
  it('QQ 原库已记录同一序号时，目录不重复计数', async () => {
    fixture.summaries.mockResolvedValue([
      { kind: 'c2c', conv: 'u_peer', count: 1, lastTs: 1700000010 },
    ]);
    fixture.logs.mockResolvedValue([{ origSeq: '42' }]);
    expect(await antiRecallRouter.createCaller({}).listRecallConversations()).toHaveLength(1);
    expect((await antiRecallRouter.createCaller({}).listRecallConversations())[0]?.count).toBe(1);
  });
});
