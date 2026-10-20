import { expect, it, vi } from 'vitest';
import { MAX_INTENT_CONTEXT_MESSAGES } from '@weq/service/intent-context';
const service = vi.hoisted(() => ({
  setConfig: vi.fn(async (input: unknown) => input),
  getSuggestions: vi.fn(async () => []),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ services: { intentSense: service } }),
  getActiveIntentSenseLocalEngine: () => null,
}));
import { intentSenseRouter } from '../src/main/ipc/routers/intent_sense';

it('上文配置路由接受独立零值和边界，拒绝越界及小数', async () => {
  const caller = intentSenseRouter.createCaller({});
  await caller.setConfig({
    analysisContextMessages: 0,
    suggestionContextMessages: MAX_INTENT_CONTEXT_MESSAGES,
  });
  expect(service.setConfig).toHaveBeenLastCalledWith({
    analysisContextMessages: 0,
    suggestionContextMessages: MAX_INTENT_CONTEXT_MESSAGES,
  });
  const calls = service.setConfig.mock.calls.length;
  for (const count of [-1, 1.5, MAX_INTENT_CONTEXT_MESSAGES + 1])
    await expect(caller.setConfig({ analysisContextMessages: count })).rejects.toThrow();
  expect(service.setConfig).toHaveBeenCalledTimes(calls);
});

it('建议查询兼容旧客户端，缓存版本不覆盖服务端实际配置', async () => {
  const caller = intentSenseRouter.createCaller({});
  await caller.getSuggestions({ kind: 'group', conv: '123', revision: 3 });
  expect(service.getSuggestions).toHaveBeenLastCalledWith('group', '123');
  await caller.getSuggestions({ kind: 'group', conv: '123' });
  expect(service.getSuggestions).toHaveBeenLastCalledWith('group', '123');
  const calls = service.getSuggestions.mock.calls.length;
  await expect(
    caller.getSuggestions({ kind: 'group', conv: '123', replyAllowed: false }),
  ).resolves.toEqual([]);
  expect(service.getSuggestions).toHaveBeenCalledTimes(calls);
  await expect(
    caller.getSuggestions({ kind: 'group', conv: '123', revision: -1 }),
  ).rejects.toThrow();
});
