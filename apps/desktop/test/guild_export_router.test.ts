import { beforeEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';

const fixture = vi.hoisted(() => ({
  start: vi.fn(async (_input: unknown) => 'synthetic-task'),
  count: vi.fn(async () => 10),
  meta: vi.fn(async (_node: string) => ({ nodeId: '100', peerTinyId: '200' })),
}));
vi.mock('../src/main/context/app_context', () => {
  const services = {
    guildDirect: { buildExportMeta: fixture.meta, countMessages: fixture.count },
    exportManager: { startTask: fixture.start },
  };
  return { getAppContext: () => ({ services }) };
});
beforeEach(() => vi.clearAllMocks());

it('频道路由接受本地精确 ID、去重并保留空集合，不将其转成日期或全部消息', async () => {
  const api = accountRouter.createCaller({});
  for (const ids of [['9007199254740993', '3', '3'], []]) {
    await api.guildDirectStartExport({
      nodeId: '100',
      name: '合成频道好友',
      format: 'txt',
      messageIds: ids,
      range: { start: 5, end: 10 },
    });
    const expected = [...new Set(ids)];
    expect(fixture.start).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'c2c',
        conv: '200',
        total: expected.length,
        filter: { messageIds: expected },
        guild: { nodeId: '100', peerTinyId: '200' },
      }),
    );
    expect(fixture.start.mock.calls.at(-1)?.[0]).not.toHaveProperty('range');
  }
  expect(fixture.count).not.toHaveBeenCalled();
  await expect(
    api.guildDirectStartExport({
      nodeId: '100',
      name: '合成频道好友',
      format: 'txt',
      messageIds: ['roaming:5:3'],
    }),
  ).rejects.toThrow();
});

it('整会话导出保留原日期和计数，禁止频道漫游补全', async () => {
  await accountRouter.createCaller({}).guildDirectStartExport({
    nodeId: '100',
    name: '合成频道好友',
    format: 'txt',
    range: { start: 5, end: 10 },
    media: {
      exportMedia: false,
      completeMessages: true,
      completeMedia: false,
      downloadVideo: false,
      downloadFile: false,
      downloadPtt: false,
      transcribeVoice: false,
    },
  });
  expect(fixture.count).toHaveBeenCalledWith('100');
  expect(fixture.start).toHaveBeenCalledWith(
    expect.objectContaining({
      total: 10,
      range: { start: 5, end: 10 },
      media: expect.objectContaining({ completeMessages: false }),
    }),
  );
});
