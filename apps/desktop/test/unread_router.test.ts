// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundClientState } from '../src/main/ipc/routers/client_state';
import { accountRouter } from '../src/main/ipc/routers/account';
import { dbEventBus } from '../src/main/context/app_context';

const fixture = vi.hoisted(() => ({
  uin: '10001',
  staticAccount: false,
  configId: 'source-a',
  root: '',
  reportOfficialRead: vi.fn(),
  getUnreadInfos: vi.fn(),
  getViewedReplySeqs: vi.fn(),
  recordReplyViews: vi.fn(),
  markRead: vi.fn(),
  markLocalRead: vi.fn(),
  visibleReadSequence: vi.fn(),
  setReadState: vi.fn(),
  undoReadState: vi.fn(),
  clearLocalReadRecords: vi.fn(),
  countsChanged: undefined as
    | ((targets: Array<{ chatType: number; uid: string }>) => void)
    | undefined,
  stopCounts: vi.fn(),
}));
vi.mock('../src/main/context/app_context', async () => {
  const { EventEmitter } = await import('node:events');
  const services = {
    accountConfig: { getRecord: () => ({ configId: fixture.configId }) },
    unreadInfo: {
      getUnreadInfos: fixture.getUnreadInfos,
      getViewedReplySeqs: fixture.getViewedReplySeqs,
      recordReplyViews: fixture.recordReplyViews,
      markReadAndReport: fixture.markRead,
      markLocalRead: fixture.markLocalRead,
      visibleReadSequence: fixture.visibleReadSequence,
      setReadState: fixture.setReadState,
      undoReadState: fixture.undoReadState,
      reportOfficialRead: fixture.reportOfficialRead,
      clearLocalReadRecords: fixture.clearLocalReadRecords,
      onCountsChanged: (listener: typeof fixture.countsChanged) => {
        fixture.countsChanged = listener;
        return fixture.stopCounts;
      },
    },
  };
  return {
    accountEventBus: new EventEmitter(),
    dbEventBus: new EventEmitter(),
    requirePlatform: () => ({ appDataRoot: () => fixture.root }),
    getAppContext: () => ({
      account: { context: { uin: fixture.uin } },
      accountIsStatic: fixture.staticAccount,
      services,
    }),
  };
});
const targets = [{ chatType: 2 as const, uid: '777' }];
beforeEach(() => {
  dbEventBus.removeAllListeners();
  vi.resetAllMocks();
  fixture.uin = '10001';
  fixture.staticAccount = false;
  fixture.configId = 'source-a';
  fixture.root = mkdtempSync(join(tmpdir(), 'weq-read-router-'));
  fixture.reportOfficialRead.mockResolvedValue({ state: 'acknowledged' });
  fixture.countsChanged = undefined;
  fixture.getUnreadInfos.mockResolvedValue([
    {
      ...targets[0],
      msgSeq: 10,
      latestSeq: '11',
      unreadCount: 1,
      readSeq: '10',
      highlights: [
        { kind: 'atMe', rawKind: 1000, msgSeq: 11, senderUid: 'u_fixture', sendTime: 1, text: '' },
      ],
    },
  ]);
  fixture.markRead.mockResolvedValue({ changed: true, report: { state: 'disabled' } });
  fixture.markLocalRead.mockResolvedValue(true);
});
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));

describe('未读 IPC', () => {
  it('公众号手动标为已读进入上报，手动未读及恢复未读的撤销不发已读通知', async () => {
    const api = accountRouter.createCaller({});
    const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
    const target = { key: 'official:u_mail', position: '0:1700000000:20' };
    boundClientState(binding).records('reads', { [target.key]: '0:1699999999:19' });
    await api.setConversationReadState({
      ...binding,
      targets: [],
      directoryTargets: [target],
      unread: true,
    });
    expect(fixture.reportOfficialRead).not.toHaveBeenCalled();
    const result = await api.setConversationReadState({
      ...binding,
      targets: [],
      directoryTargets: [target],
      unread: false,
    });
    expect(fixture.reportOfficialRead).toHaveBeenCalledWith(
      'u_mail',
      target.position,
      expect.any(Function),
      true,
    );
    const valid = fixture.reportOfficialRead.mock.calls[0]![2] as () => boolean;
    expect(valid()).toBe(true);
    await api.undoConversationReadState({
      expectedAccountUin: '10001',
      undoToken: result.undoToken,
    });
    expect(valid()).toBe(false);
    expect(fixture.reportOfficialRead).toHaveBeenCalledOnce();
  });
  it('清除 WeQ 已读记录要求当前账号及数据源，拒绝旧页面的请求', async () => {
    const api = accountRouter.createCaller({});
    const input = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
    await expect(api.clearLocalReadRecords(input)).resolves.toEqual({ cleared: true });
    expect(fixture.clearLocalReadRecords).toHaveBeenCalledOnce();
    fixture.configId = 'source-b';
    await expect(api.clearLocalReadRecords(input)).rejects.toThrow('数据源已切换');
    expect(fixture.clearLocalReadRecords).toHaveBeenCalledOnce();
  });
  it('共享小表快照变化只发目标，切号和退订后不回灌', async () => {
    const stream = await accountRouter.createCaller({}).onUnreadChanged({});
    const next = vi.fn();
    const subscription = stream.subscribe({ next });
    fixture.countsChanged?.(targets);
    expect(next).toHaveBeenCalledWith(targets);
    fixture.configId = 'source-b';
    fixture.countsChanged?.(targets);
    expect(next).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    expect(fixture.stopCounts).toHaveBeenCalledOnce();
  });

  it('未指定绑定字段时仍锁定订阅建立时的账号，切号不再推送', async () => {
    const stream = await accountRouter.createCaller({}).onUnreadChanged({});
    const next = vi.fn();
    const subscription = stream.subscribe({ next });
    fixture.countsChanged?.(targets);
    expect(next).toHaveBeenCalledWith([{ chatType: 2, uid: '777' }]);
    fixture.uin = '10002';
    fixture.countsChanged?.(targets);
    expect(next).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  it('消息差分不重复发布未读，统一快照通知携带去重目标', async () => {
    const api = accountRouter.createCaller({});
    const stream = await api.onUnreadChanged({
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
    });
    const next = vi.fn();
    const subscription = stream.subscribe({ next });
    dbEventBus.emit('new', { c2c: [{ targetUid: 'u_other' }], group: [] });
    expect(next).not.toHaveBeenCalled();
    const change = [
      { chatType: 1, uid: 'u_other' },
      { chatType: 1, uid: 'u_other' },
      { chatType: 2, uid: '777' },
      { chatType: 8, uid: 'device' },
    ];
    fixture.countsChanged?.(change);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith([
      { chatType: 1, uid: 'u_other' },
      { chatType: 2, uid: '777' },
      { chatType: 8, uid: 'device' },
    ]);
    fixture.configId = 'source-b';
    fixture.countsChanged?.(change);
    fixture.uin = '10002';
    fixture.countsChanged?.(change);
    expect(next).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
    expect(dbEventBus.listenerCount('new')).toBe(0);
  });
  it('设备保留真实类型，同号切来源后拒绝旧查询和标已读', async () => {
    const api = accountRouter.createCaller({});
    const input = {
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      targets: [{ chatType: 8 as const, uid: 'device-fixture' }],
    };
    await api.getUnreadInfos(input);
    expect(fixture.getUnreadInfos).toHaveBeenCalledWith(input.targets, undefined, true);
    fixture.getUnreadInfos.mockImplementationOnce(async () => {
      fixture.configId = 'source-b';
      return [];
    });
    await expect(api.getUnreadInfos(input)).rejects.toThrow('数据源已切换');
    await expect(
      api.markConversationRead({
        expectedAccountUin: '10001',
        expectedAccountConfigId: 'source-a',
        chatType: 8,
        uid: 'device-fixture',
        latestSeq: '1',
      }),
    ).rejects.toThrow('数据源已切换');
    expect(fixture.markRead).not.toHaveBeenCalled();
  });
  it('按视口标已读只提交确认的序号，换数据源后拒绝迟到的结果', async () => {
    const api = accountRouter.createCaller({});
    const input = {
      ...targets[0]!,
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source-a',
      visibleSeqs: ['11', '13'],
    };
    await expect(api.markViewportRead(input)).resolves.toMatchObject({ changed: false });
    expect(fixture.markRead).not.toHaveBeenCalled();

    fixture.visibleReadSequence.mockResolvedValueOnce('11');
    await expect(api.markViewportRead(input)).resolves.toMatchObject({ changed: true });
    expect(fixture.markRead).toHaveBeenCalledWith(2, '777', '11');

    fixture.visibleReadSequence.mockImplementationOnce(async () => {
      fixture.configId = 'source-b';
      return '11';
    });
    await expect(api.markViewportRead(input)).rejects.toThrow('数据源已切换');
    expect(fixture.markRead).toHaveBeenCalledOnce();
  });
  it('单条回复回执绑定账号来源，随未读快照交付但不写已读位置', async () => {
    const api = accountRouter.createCaller({});
    const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
    const input = { ...binding, uid: '777', sequences: ['11'] };
    await expect(api.recordReplyViews(input)).resolves.toEqual({ recorded: true });
    expect(fixture.recordReplyViews).toHaveBeenCalledWith('777', ['11']);
    fixture.getViewedReplySeqs.mockReturnValue(['11']);
    await expect(api.getUnreadInfos({ ...binding, targets })).resolves.toMatchObject([
      { viewedReplySeqs: ['11'], readSeq: '10', unreadCount: 1 },
    ]);
    fixture.configId = 'source-b';
    await expect(api.recordReplyViews(input)).rejects.toThrow('数据源已切换');
    expect(fixture.recordReplyViews).toHaveBeenCalledOnce();
    expect(fixture.markRead).not.toHaveBeenCalled();
  });
  it('手动批量标记及撤销强制账号隔离，结果沿用未读序列化', async () => {
    const api = accountRouter.createCaller({});
    const token = '00000000-0000-4000-8000-000000000001';
    fixture.setReadState.mockResolvedValue({
      undoToken: token,
      failed: 1,
      rows: await fixture.getUnreadInfos(),
    });
    fixture.undoReadState.mockResolvedValue({
      restored: 1,
      pending: 0,
      rows: await fixture.getUnreadInfos(),
    });
    expect(
      await api.setConversationReadState({ expectedAccountUin: '10001', targets, unread: true }),
    ).toMatchObject({
      undoToken: token,
      failed: 1,
      rows: [{ latestSeq: '11', highlights: [{ msgSeq: '11' }] }],
    });
    expect(fixture.setReadState).toHaveBeenCalledWith(targets, true);
    await expect(
      api.undoConversationReadState({ expectedAccountUin: '10001', undoToken: token }),
    ).resolves.toMatchObject({ restored: 1, pending: 0 });
    fixture.uin = '10002';
    await expect(
      api.setConversationReadState({ expectedAccountUin: '10001', targets, unread: false }),
    ).rejects.toThrow('账号已切换');
    await expect(
      api.undoConversationReadState({ expectedAccountUin: '10001', undoToken: token }),
    ).rejects.toThrow('账号已切换');
    expect(fixture.setReadState).toHaveBeenCalledTimes(1);
    expect(fixture.undoReadState).toHaveBeenCalledTimes(1);
    await expect(
      api.setConversationReadState({ expectedAccountUin: '10002', targets: [], unread: true }),
    ).rejects.toThrow();
  });
  it('批量响应保留精确字符串字段，且限制单批大小', async () => {
    const api = accountRouter.createCaller({});
    expect(await api.getUnreadInfos({ expectedAccountUin: '10001', targets })).toMatchObject([
      {
        uid: '777',
        msgSeq: '10',
        latestSeq: '11',
        unreadCount: 1,
        readSeq: '10',
        readError: false,
        highlights: [{ msgSeq: '11', sendTime: '1' }],
      },
    ]);
    expect(fixture.getUnreadInfos).toHaveBeenCalledWith(targets, undefined, true);
    await expect(
      api.getUnreadInfos({
        expectedAccountUin: '10001',
        targets: Array.from({ length: 257 }, () => targets[0]!),
      }),
    ).rejects.toThrow();
    expect(fixture.getUnreadInfos).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false, true])('未读查询原样传递水位模式 %s', async (watermarksOnly) => {
    const api = accountRouter.createCaller({});
    await api.getUnreadInfos({
      expectedAccountUin: '10001',
      targets,
      ...(watermarksOnly === undefined ? {} : { watermarksOnly }),
    });
    expect(fixture.getUnreadInfos).toHaveBeenCalledTimes(1);
    expect(fixture.getUnreadInfos).toHaveBeenCalledWith(targets, watermarksOnly, true);
  });

  it('切号后的旧刷新和已读请求不得访问新账号', async () => {
    fixture.uin = '10002';
    const api = accountRouter.createCaller({});
    await expect(api.getUnreadInfos({ expectedAccountUin: '10001', targets })).rejects.toThrow(
      '账号已切换',
    );
    await expect(
      api.markConversationRead({ expectedAccountUin: '10001', ...targets[0]! }),
    ).rejects.toThrow('账号已切换');
    expect(fixture.getUnreadInfos).not.toHaveBeenCalled();
    expect(fixture.markRead).not.toHaveBeenCalled();
  });

  it('正常请求传递固定水位，静态账号只推进 WeQ 本地阅读位置', async () => {
    const api = accountRouter.createCaller({});
    await api.markConversationRead({
      expectedAccountUin: '10001',
      ...targets[0]!,
      latestSeq: '11',
    });
    expect(fixture.markRead).toHaveBeenCalledWith(2, '777', '11');
    fixture.staticAccount = true;
    expect(await api.markConversationRead({ ...targets[0]! })).toEqual({
      changed: true,
      report: { state: 'unavailable' },
    });
    expect(fixture.markRead).toHaveBeenCalledTimes(1);
    expect(fixture.markLocalRead).toHaveBeenCalledWith(2, '777', undefined);
  });
});
