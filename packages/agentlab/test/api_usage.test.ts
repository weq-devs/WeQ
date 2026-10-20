import { afterEach, expect, it, vi } from 'vitest';
import { beginApiUsage, parseApiUsage, requestApiJson } from '../src/api_usage';
import type { AgentLabEndpoint, AgentLabUsage } from '../src/types';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const updates: AgentLabUsage[] = [];
  const endpoint: AgentLabEndpoint = {
    baseUrl: 'https://fixture.invalid/v1',
    apiKey: 'fixture',
    model: 'fixture-model',
    feature: 'intent-analysis',
    onUsage: (entry) => updates.push(entry),
  };
  return { endpoint, updates };
}

it('usage 缺失与部分字段保持未知，只有完整分项才计算总量', () => {
  expect(parseApiUsage({})).toEqual({
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
  });
  expect(parseApiUsage({ usage: { prompt_tokens: 5 } })).toEqual({
    promptTokens: 5,
    completionTokens: null,
    totalTokens: null,
  });
  expect(parseApiUsage({ usage: { prompt_tokens: 5, completion_tokens: 0 } })).toEqual({
    promptTokens: 5,
    completionTokens: 0,
    totalTokens: 5,
  });
  expect(parseApiUsage({ usage: { input_tokens: 5, output_tokens: 0 } })).toEqual({
    promptTokens: 5,
    completionTokens: 0,
    totalTokens: 5,
  });
  expect(
    parseApiUsage({ usage: { prompt_tokens: -1, completion_tokens: NaN, total_tokens: '7' } }),
  ).toEqual({ promptTokens: null, completionTokens: null, totalTokens: null });
});

it('流式重复 usage 和结束回执复用同一 ID，不把缺失字段覆盖成零', () => {
  const f = fixture();
  const call = beginApiUsage(f.endpoint, true);
  call.report({ usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  call.report({ usage: { total_tokens: 12 } });
  call.finish('cancelled');
  call.finish('success');
  expect(new Set(f.updates.map((u) => u.requestId)).size).toBe(1);
  expect(f.updates.at(-1)).toMatchObject({
    status: 'cancelled',
    promptTokens: 10,
    completionTokens: 2,
    totalTokens: 12,
    stream: true,
    feature: 'intent-analysis',
  });
});

it('成功但无 usage 的实际请求仍记录一次未知用量', async () => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [] })));
  vi.stubGlobal('fetch', fetch);
  await requestApiJson(f.endpoint, '/chat/completions', { method: 'POST' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(f.updates.at(-1)).toMatchObject({ status: 'success', totalTokens: null });
});

it.each(['http', 'network', 'cancel', 'timeout', 'provider'] as const)(
  '真实 %s 失败或取消保留未知账目',
  async (mode) => {
    const f = fixture();
    const error = new DOMException(
      'fixture',
      mode === 'cancel' ? 'AbortError' : mode === 'timeout' ? 'TimeoutError' : 'NetworkError',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        if (mode === 'http') return new Response('denied', { status: 429 });
        if (mode === 'provider')
          return new Response(
            JSON.stringify({
              error: { message: '', code: 'fixture-failure' },
              usage: { total_tokens: 1 },
            }),
          );
        throw error;
      }),
    );
    await expect(
      requestApiJson(f.endpoint, '/chat/completions', { method: 'POST' }),
    ).rejects.toThrow();
    expect(f.updates.at(-1)).toMatchObject({
      status: mode === 'cancel' ? 'cancelled' : 'failed',
      totalTokens: mode === 'provider' ? 1 : null,
    });
  },
);

it('调用前已取消不发请求、不记不存在的尝试；本地推理不进入 API 回调', async () => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response('{}'));
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  controller.abort();
  await expect(
    requestApiJson(f.endpoint, '/chat/completions', { signal: controller.signal }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(f.updates).toEqual([]);
  await requestApiJson({ ...f.endpoint, source: 'local' }, '/chat/completions', {});
  expect(f.updates).toEqual([]);
});

it('记账回调抛错不改变实际请求结果，不诱导重试', async () => {
  const f = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{"ok":true}')),
  );
  await expect(
    requestApiJson(
      {
        ...f.endpoint,
        onUsage: () => {
          throw new Error('disk');
        },
      },
      '/chat/completions',
      {},
    ),
  ).resolves.toEqual({ ok: true });
});
