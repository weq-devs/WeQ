// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { MAX_INTENT_CONTEXT_MESSAGES } from '@weq/service/intent-context';
const service = vi.hoisted(() => ({
  setConfig: vi.fn(async (input: unknown) => input),
  getSuggestions: vi.fn(async () => []),
  getSuggestionHistory: vi.fn(() => []),
  getSuggestionRound: vi.fn(async () => null),
  getSuggestionDetails: vi.fn(() => null),
  stopSuggestions: vi.fn(() => true),
  getProfile: vi.fn(async () => null),
  analyzeMessage: vi.fn(async () => null),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ services: { intentSense: service } }),
  getActiveIntentSenseLocalEngine: () => null,
}));
import { intentSenseRouter } from '../src/main/ipc/routers/intent_sense';

it('等待动画、回退列表与历史轮数通过现有配置接口校验并传递', async () => {
  const caller = intentSenseRouter.createCaller({});
  await caller.setConfig({
    loadingAnimation: false,
    suggestionFallbackEnabled: false,
    suggestionFallbackTexts: [' A ', 'B'],
    suggestionHistoryLimit: 0,
  });
  expect(service.setConfig).toHaveBeenLastCalledWith({
    loadingAnimation: false,
    suggestionFallbackEnabled: false,
    suggestionFallbackTexts: ['A', 'B'],
    suggestionHistoryLimit: 0,
  });
  for (const patch of [
    { suggestionFallbackTexts: ['A', ' A '] },
    { suggestionFallbackTexts: [' '] },
    { suggestionFallbackTexts: ['x'.repeat(501)] },
    { suggestionHistoryLimit: -1 },
    { suggestionHistoryLimit: 10001 },
  ])
    await expect(caller.setConfig(patch)).rejects.toThrow();
});

it('模式配置、只读画像缓存与明确菜单分析完整传递', async () => {
  const caller = intentSenseRouter.createCaller({});
  await caller.setConfig({ analysisMode: 'manual', profileMode: 'auto', suggestionMode: 'manual' });
  expect(service.setConfig).toHaveBeenLastCalledWith({
    analysisMode: 'manual',
    profileMode: 'auto',
    suggestionMode: 'manual',
  });
  await expect(caller.setConfig({ analysisMode: 'invalid' } as never)).rejects.toThrow();
  await caller.getProfile({ peerUid: 'u_peer', cachedOnly: true });
  expect(service.getProfile).toHaveBeenLastCalledWith('u_peer', { cachedOnly: true });
  await caller.analyzeMessage({ kind: 'group', conv: '123', msgId: '42', manual: true });
  expect(service.analyzeMessage).toHaveBeenLastCalledWith('group', '123', '42', { manual: true });
});

it('轮次请求保留禁用及手动刷新语义，详情可按会话读取在途轮次或按 ID 固定读取', async () => {
  const caller = intentSenseRouter.createCaller({});
  await caller.getSuggestionRound({ kind: 'c2c', conv: 'u_peer', refresh: true });
  expect(service.getSuggestionRound).toHaveBeenLastCalledWith('c2c', 'u_peer', { refresh: true });
  const calls = service.getSuggestionRound.mock.calls.length;
  await expect(
    caller.getSuggestionRound({ kind: 'c2c', conv: 'u_peer', replyAllowed: false }),
  ).resolves.toBeNull();
  expect(service.getSuggestionRound).toHaveBeenCalledTimes(calls);
  await expect(
    caller.getSuggestionDetails({ kind: 'group', conv: '123', id: 'round-1' }),
  ).resolves.toBeNull();
  expect(service.getSuggestionDetails).toHaveBeenLastCalledWith('group', '123', 'round-1');
  await expect(caller.getSuggestionDetails({ kind: 'c2c', conv: 'u_peer' })).resolves.toBeNull();
  expect(service.getSuggestionDetails).toHaveBeenLastCalledWith('c2c', 'u_peer', undefined);
  await expect(
    caller.getSuggestionDetails({ kind: 'c2c', conv: 'u_peer', id: '' }),
  ).rejects.toThrow();
  expect(service.getSuggestionRound).toHaveBeenCalledTimes(calls);
});

it('停止推荐只转交指定会话，不修改推荐开关', async () => {
  const caller = intentSenseRouter.createCaller({});
  const changes = service.setConfig.mock.calls.length;
  await expect(caller.stopSuggestions({ kind: 'group', conv: '123' })).resolves.toBe(true);
  expect(service.stopSuggestions).toHaveBeenCalledWith('group', '123');
  expect(service.setConfig).toHaveBeenCalledTimes(changes);
});

it('回复历史读取按会话隔离，不触发重新生成', async () => {
  const caller = intentSenseRouter.createCaller({});
  const calls = service.getSuggestions.mock.calls.length;
  await expect(caller.getSuggestionHistory({ kind: 'c2c', conv: 'u_peer' })).resolves.toEqual([]);
  expect(service.getSuggestionHistory).toHaveBeenLastCalledWith('c2c', 'u_peer');
  expect(service.getSuggestions).toHaveBeenCalledTimes(calls);
  await expect(caller.getSuggestionHistory({ kind: 'group', conv: '' })).rejects.toThrow();
});

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
  expect(service.getSuggestions).toHaveBeenLastCalledWith('group', '123', { refresh: undefined });
  await caller.getSuggestions({ kind: 'group', conv: '123' });
  expect(service.getSuggestions).toHaveBeenLastCalledWith('group', '123', { refresh: undefined });
  const calls = service.getSuggestions.mock.calls.length;
  await expect(
    caller.getSuggestions({ kind: 'group', conv: '123', replyAllowed: false }),
  ).resolves.toEqual([]);
  expect(service.getSuggestions).toHaveBeenCalledTimes(calls);
  await expect(
    caller.getSuggestions({ kind: 'group', conv: '123', revision: -1 }),
  ).rejects.toThrow();
});

it('显示开关按独立布尔值传给服务，拒绝字符串', async () => {
  const caller = intentSenseRouter.createCaller({});
  await caller.setConfig({ persistentDisplay: false, hoverDisplay: true });
  expect(service.setConfig).toHaveBeenLastCalledWith({
    persistentDisplay: false,
    hoverDisplay: true,
  });
  await expect(caller.setConfig({ persistentDisplay: 'false' } as never)).rejects.toThrow();
});

it('手动换一批将刷新意图交给服务，不改变自动查询的禁用语义', async () => {
  const caller = intentSenseRouter.createCaller({});
  await caller.getSuggestions({ kind: 'group', conv: '123', refresh: true });
  expect(service.getSuggestions).toHaveBeenLastCalledWith('group', '123', { refresh: true });
  const calls = service.getSuggestions.mock.calls.length;
  await caller.getSuggestions({ kind: 'group', conv: '123', replyAllowed: false, refresh: true });
  expect(service.getSuggestions).toHaveBeenCalledTimes(calls);
});
