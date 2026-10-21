import { afterEach, expect, it, vi } from 'vitest';
import { accountRouter } from '../src/main/ipc/routers/account';
const fixture = vi.hoisted(() => ({
  configId: 'fixture-online',
  uin: '10001',
  start: vi.fn(async (_input: unknown) => 'task'),
  messages: [{ id: 'a', role: 'user' as const, text: '合成正文', ts: 1 }],
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    account: { context: { uin: fixture.uin } },
    services: {
      accountConfig: { getRecord: () => ({ configId: fixture.configId }) },
      assistant: {
        listSessions: () => [{ id: 's', title: '合成助手' }],
        getConversation: () => fixture.messages,
      },
      exportManager: { startTask: fixture.start },
    },
  }),
}));
afterEach(() => {
  fixture.configId = 'fixture-online';
  fixture.uin = '10001';
  vi.clearAllMocks();
});
const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture-online' };
const target = { kind: 'assistant' as const, ownerId: 'assistant', sessionId: 's' };
it('生成内容导出在服务端绑定同号数据源，切号不读取或创建其他账号任务', async () => {
  const api = accountRouter.createCaller({});
  fixture.configId = 'fixture-static';
  await expect(api.startGeneratedExport({ ...binding, target, formats: ['json'] })).rejects.toThrow(
    '账号数据源已切换',
  );
  await expect(api.generatedConversation({ ...binding, target })).rejects.toThrow(
    '账号数据源已切换',
  );
  fixture.uin = '10002';
  await expect(api.generatedConversations(binding)).rejects.toThrow('账号已切换');
  expect(fixture.start).not.toHaveBeenCalled();
});
it('路由只接收真实本地记录身份，空集合不扩大、缺失条目不静默遗漏', async () => {
  const api = accountRouter.createCaller({});
  await api.startGeneratedExport({ ...binding, target, formats: ['json', 'csv'], messageIds: [] });
  expect(fixture.start).toHaveBeenCalledWith(
    expect.objectContaining({
      generated: expect.objectContaining({
        origin: 'local-generated',
        selectedIds: [],
        messages: [],
        target,
      }),
      total: 0,
    }),
  );
  fixture.start.mockClear();
  await expect(
    api.startGeneratedExport({ ...binding, target, formats: ['json'], messageIds: ['missing'] }),
  ).rejects.toThrow('不存在或尚未持久化');
  expect(fixture.start).not.toHaveBeenCalled();
});
