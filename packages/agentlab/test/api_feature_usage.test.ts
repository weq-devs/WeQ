import { afterEach, expect, it, vi } from 'vitest';
import { embedTexts, testChatEndpoint } from '../src/http';
import { describeSticker, scoreInteractionSentiment, summarizeVoiceScenario } from '../src/extract';
import type { AgentLabEndpoint, AgentLabUsage } from '../src/types';

afterEach(() => vi.unstubAllGlobals());
function fixture(body: unknown) {
  const updates: AgentLabUsage[] = [];
  const fetch = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetch);
  const endpoint: AgentLabEndpoint = {
    baseUrl: 'https://fixture.invalid',
    apiKey: 'fixture',
    model: 'fixture',
    onUsage: (u) => updates.push(u),
  };
  return { updates, endpoint, fetch };
}

it('embedding 保留未知的输出分项，实际请求不再重复 reportUsage', async () => {
  const f = fixture({
    data: [{ embedding: [1, 2] }],
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
  await embedTexts({ ...f.endpoint, kind: 'embedding' }, 'fixture');
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(new Set(f.updates.map((u) => u.requestId)).size).toBe(1);
  expect(f.updates.at(-1)).toMatchObject({
    kind: 'embedding',
    promptTokens: 1,
    completionTokens: null,
    totalTokens: 1,
    status: 'success',
  });
});

it('连接测试的真实聊天请求保留测试功能归属', async () => {
  const f = fixture({ choices: [{ message: { content: 'fixture' } }], usage: { total_tokens: 2 } });
  await expect(
    testChatEndpoint({ ...f.endpoint, feature: 'connection-test' }),
  ).resolves.toMatchObject({ ok: true });
  expect(f.updates.at(-1)).toMatchObject({ feature: 'connection-test', totalTokens: 2 });
});

it('关系评分按实际功能记账，不一律归到画像提炼', async () => {
  const f = fixture({
    choices: [{ message: { content: '{"affinityDelta":1,"moodDelta":1}' } }],
    usage: { total_tokens: 2 },
  });
  await scoreInteractionSentiment(f.endpoint, 'fixture', 'fixture');
  expect(f.updates.at(-1)).toMatchObject({ feature: '关系情感打分', totalTokens: 2 });
});

it('表情解读保留视觉能力和功能归属', async () => {
  const f = fixture({
    choices: [{ message: { content: '{"description":"fixture","scenario":"fixture"}' } }],
    usage: { total_tokens: 2 },
  });
  await describeSticker(
    { ...f.endpoint, kind: 'vision' },
    'fixture',
    'data:image/png;base64,AA==',
    'fixture',
  );
  expect(f.updates.at(-1)).toMatchObject({
    feature: 'sticker-description',
    kind: 'vision',
    totalTokens: 2,
  });
});

it('语音场景总结的轻量聊天调用同样记账', async () => {
  const f = fixture({ choices: [{ message: { content: 'fixture' } }], usage: { total_tokens: 2 } });
  await summarizeVoiceScenario(f.endpoint, 'fixture', ['fixture']);
  expect(f.updates.at(-1)).toMatchObject({ feature: 'voice-scenario', totalTokens: 2 });
});
