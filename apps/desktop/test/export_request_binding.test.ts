import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
import { marketEmojiRouter } from '../src/main/ipc/routers/market_emoji';
import { emojiPackRouter } from '../src/main/ipc/routers/emoji_export';

const state = vi.hoisted(() => ({
  uin: '10001',
  configId: 'source-a',
  replacement: false,
  start: vi.fn(async (_input: unknown) => 'task-a'),
  market: vi.fn(async (..._input: unknown[]) => 'market-a'),
  emoji: vi.fn(async (..._input: unknown[]) => 'emoji-a'),
  schedule: vi.fn(async (_input: unknown) => 'schedule-a'),
  meta: vi.fn(async (_node: string) => ({ nodeId: '123', peerTinyId: '456' })),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    accountConfig: { getRecord: () => ({ configId: state.configId }) },
    exportManager: {
      startTask: state.start,
      startMarketPackDownload: state.market,
      startEmojiPackExport: state.emoji,
    },
    guildDirect: { buildExportMeta: state.meta, countMessages: async () => 2 },
  };
  const replacement = { ...services };
  return {
    getAppContext: () => ({
      account: { context: { uin: state.uin } },
      services: state.replacement ? replacement : services,
      scheduler: { create: state.schedule },
    }),
  };
});
beforeEach(() => {
  state.uin = '10001';
  state.configId = 'source-a';
  state.replacement = false;
  vi.clearAllMocks();
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
function requests() {
  const account = accountRouter.createCaller({}),
    market = marketEmojiRouter.createCaller({}),
    emoji = emojiPackRouter.createCaller({});
  return [
    () =>
      account.startExport({
        ...binding,
        kind: 'c2c',
        conv: 'u_peer',
        name: '合成消息',
        format: 'json',
        total: 0,
      }),
    () => account.startCollectionExport({ ...binding, name: '合成收藏', format: 'json' }),
    () =>
      account.guildDirectStartExport({
        ...binding,
        nodeId: '123',
        name: '合成频道',
        format: 'json',
      }),
    () => market.startDownload({ ...binding, packs: [{ id: '123', name: '合成包' }] }),
    () => emoji.startExport({ ...binding, scopes: ['own'] }),
  ];
}
describe('导出创建请求的数据源绑定', () => {
  it('表情导出格式透传给任务，旧请求默认目录，未知格式在创建前拒绝', async () => {
    const api = emojiPackRouter.createCaller({});
    await api.startExport({ ...binding, scopes: ['own'] });
    expect(state.emoji).toHaveBeenLastCalledWith(['own'], undefined, 'directory');
    await api.startExport({
      ...binding,
      scopes: ['received'],
      format: 'zip',
      savePolicy: { mode: 'after' },
    });
    expect(state.emoji).toHaveBeenLastCalledWith(['received'], { mode: 'after' }, 'zip');
    await expect(
      api.startExport({ ...binding, scopes: ['own'], format: 'tar' as 'zip' }),
    ).rejects.toThrow();
    expect(state.emoji).toHaveBeenCalledTimes(2);
  });
  it('相同来源可创建各类任务，同号换配置在读取或建任务前拒绝', async () => {
    state.configId = 'source-b';
    for (const request of requests()) await expect(request()).rejects.toThrow(/数据源/);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.market).not.toHaveBeenCalled();
    expect(state.emoji).not.toHaveBeenCalled();
    expect(state.meta).not.toHaveBeenCalled();
    state.configId = 'source-a';
    for (const request of requests()) await request();
    expect(state.start).toHaveBeenCalledTimes(3);
    expect(state.market).toHaveBeenCalledOnce();
    expect(state.emoji).toHaveBeenCalledOnce();
  });
  it('切换 QQ 号不能把旧选择导出到新账号', async () => {
    state.uin = '10002';
    for (const request of requests()) await expect(request()).rejects.toThrow(/账号/);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.market).not.toHaveBeenCalled();
    expect(state.emoji).not.toHaveBeenCalled();
  });
  it('频道元数据读取期间服务实例更换时不创建任务，即使账号与配置名相同', async () => {
    state.meta.mockImplementationOnce(async () => {
      state.replacement = true;
      return { nodeId: '123', peerTinyId: '456' };
    });
    await expect(
      accountRouter
        .createCaller({})
        .guildDirectStartExport({ ...binding, nodeId: '123', name: '合成频道', format: 'json' }),
    ).rejects.toThrow(/切换/);
    expect(state.start).not.toHaveBeenCalled();
  });
  it('创建计划同样绑定确认时的来源，不向新数据源登记旧范围', async () => {
    const api = accountRouter.createCaller({});
    const input = {
      ...binding,
      name: '合成计划',
      format: 'json' as const,
      conversations: [{ id: 'u_peer', name: '合成', kind: 'c2c' as const, total: 0 }],
      schedule: { mode: 'daily' as const, time: '09:00', intervalHours: 24 },
      options: {
        range: { preset: 'all' as const, start: null, end: null },
        exportMedia: false,
        completeMessages: false,
        exportAvatar: false,
        completeMedia: false,
        downloadVideo: false,
        downloadFile: false,
        downloadPtt: false,
        transcribeVoice: false,
      },
    };
    state.configId = 'source-b';
    await expect(api.createSchedule(input)).rejects.toThrow(/数据源/);
    expect(state.schedule).not.toHaveBeenCalled();
    state.configId = 'source-a';
    await api.createSchedule(input);
    expect(state.schedule).toHaveBeenCalledOnce();
  });
});
