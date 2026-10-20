import { afterEach, expect, it, vi } from 'vitest';
import { TtsService, type TtsProviderConfig } from '../src/tts';
import type { AgentLabUsage } from '../src/types';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const cfg: TtsProviderConfig = {
  id: 'fixture',
  name: 'fixture',
  vendor: 'openai-compatible',
  baseUrl: 'https://fixture.invalid/v1',
  apiKey: 'fixture',
  model: 'fixture-tts',
  createdAt: 0,
  updatedAt: 0,
};

it.each([true, false])(
  '远程语音合成实际请求 success=%s 保留未知 Token，不按字符伪造',
  async (success) => {
    const updates: AgentLabUsage[] = [];
    const service = new TtsService((u) => updates.push(u));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        success
          ? new Response(new Uint8Array(101).fill(1))
          : new Response('denied', { status: 403 }),
      ),
    );
    if (success) await service.synthesize(cfg, '测试');
    else await expect(service.synthesize(cfg, '测试')).rejects.toThrow();
    expect(new Set(updates.map((u) => u.requestId)).size).toBe(1);
    expect(updates.at(-1)).toMatchObject({
      kind: 'speech',
      feature: 'tts-synthesis',
      totalTokens: null,
      status: success ? 'success' : 'failed',
    });
  },
);

it('语音输入为空时没有发生请求，不记账', async () => {
  const onUsage = vi.fn();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(new TtsService(onUsage).synthesize(cfg, ' ')).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(onUsage).not.toHaveBeenCalled();
});

it('语音后端的真实重试分配不同请求 ID，不只记录第一次失败', async () => {
  vi.useFakeTimers();
  const updates: AgentLabUsage[] = [];
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ++calls === 1
        ? new Response('denied', { status: 503 })
        : new Response(new Uint8Array(101).fill(1)),
    ),
  );
  const pending = new TtsService((u) => updates.push(u)).synthesize(
    { ...cfg, vendor: 'gsv2p' },
    '测试',
  );
  await vi.advanceTimersByTimeAsync(3000);
  await pending;
  const finals = updates.filter((u) => u.status !== 'pending');
  expect(new Set(updates.map((u) => u.requestId)).size).toBe(2);
  expect(finals.map((u) => u.status)).toEqual(['failed', 'success']);
});
