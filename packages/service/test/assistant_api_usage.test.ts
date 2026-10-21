import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentLabEndpoint } from '@weq/agentlab';
import { AssistantService } from '../src/account/assistant';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'weq-assistant-usage-'));
  dirs.push(dir);
  const usage = new TokenUsageStore(join(dir, 'usage.json'));
  const endpoint: AgentLabEndpoint = {
    baseUrl: 'https://fixture.invalid',
    apiKey: 'fixture',
    model: 'fixture',
    onUsage: (u) => usage.record({ ...u, ts: u.startedAt!, scope: 'assistant' }),
  };
  const service = new AssistantService(
    dir,
    () => endpoint,
    usage,
    new ConversationStore(join(dir, 'conversations.json')),
  );
  service.setConfig({
    model: { providerId: 'fixture', model: 'fixture' },
    reasoningEffort: 'medium',
  });
  // 直接执行真实请求实现，依赖只替换网络，不复制其 SSE 或重试逻辑。
  const api = service as unknown as {
    callApiStream(
      endpoint: AgentLabEndpoint,
      messages: [],
      specs: [],
      emit: (step: unknown) => void,
      signal?: AbortSignal,
    ): Promise<unknown>;
    generateTitle(user: string, reply: string): Promise<string>;
  };
  return { usage, endpoint, api };
}
const usageEvent =
  'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n';

it('助手流式重复 usage 不重复计数，400／429 的真实重试独立留账', async () => {
  const f = fixture();
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response('unsupported', { status: 400 });
      if (calls === 2)
        return new Response(
          JSON.stringify({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }),
          { status: 429 },
        );
      return new Response(usageEvent + usageEvent + 'data: [DONE]\n\n');
    }),
  );
  await f.api.callApiStream(f.endpoint, [], [], () => {});
  expect(f.usage.getStats()).toMatchObject({
    totalCalls: 3,
    totalTokens: 12,
    knownCalls: 2,
    unknownCalls: 1,
    failedCalls: 2,
  });
});

it('流式完成但服务商没有 usage 时保留未知，不填零', async () => {
  const f = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n'),
    ),
  );
  await f.api.callApiStream(f.endpoint, [], [], () => {});
  expect(f.usage.getStats()).toMatchObject({
    totalCalls: 1,
    totalTokens: 0,
    unknownCalls: 1,
    knownCalls: 0,
    pendingCalls: 0,
  });
});

it('流已收到 usage 后取消仍保留用量，不能在 reader 抛错时漏记', async () => {
  const f = fixture();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode(usageEvent));
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(stream)),
  );
  const pending = f.api.callApiStream(f.endpoint, [], [], () => {});
  const rejected = expect(pending).rejects.toThrow('fixture-cancel');
  await vi.waitFor(() => expect(f.usage.getStats().totalTokens).toBe(12));
  controller.error(new DOMException('fixture-cancel', 'AbortError'));
  await rejected;
  expect(f.usage.getStats()).toMatchObject({
    totalCalls: 1,
    totalTokens: 12,
    cancelledCalls: 1,
    unknownCalls: 0,
  });
});

it('助手非流式标题调用也记账，并保留功能归属', async () => {
  const f = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '测试标题' } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        ),
    ),
  );
  await expect(f.api.generateTitle('fixture-user', 'fixture-reply')).resolves.toBe('测试标题');
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 1, totalTokens: 5 });
  expect(f.usage.getStats().byFeature[0]?.feature).toBe('assistant-title');
});

it('HTTP 200 的 SSE 错误帧仍按失败记账，保留已返回的 usage', async () => {
  const f = fixture();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          'data: {"error":{"message":"fixture-failure"},"usage":{"total_tokens":3}}\n\n',
        ),
    ),
  );
  await expect(f.api.callApiStream(f.endpoint, [], [], () => {})).rejects.toThrow(
    'fixture-failure',
  );
  expect(f.usage.getStats()).toMatchObject({
    totalCalls: 1,
    failedCalls: 1,
    totalTokens: 3,
    unknownCalls: 0,
  });
});

const temperatureError = {
  error: {
    param: 'temperature',
    code: 'unsupported_parameter',
    message: 'Unsupported parameter: temperature',
  },
  usage: { total_tokens: 1 },
};
it.each(['http', 'sse', 'json', 'json-no-header'] as const)(
  '助手 %s 温度拒绝只回退一次，消息、工具及 reasoning 设置不变',
  async (kind) => {
    const f = fixture();
    const first =
      kind === 'sse'
        ? new Response(`data: ${JSON.stringify(temperatureError)}\n\n`)
        : new Response(JSON.stringify(temperatureError), {
            status: kind === 'http' ? 400 : 200,
            headers: kind === 'json' ? { 'content-type': 'application/json' } : undefined,
          });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(
        new Response(
          'data: {"choices":[{"delta":{"content":"合成恢复"}}]}\n\n' +
            usageEvent +
            'data: [DONE]\n\n',
        ),
      );
    vi.stubGlobal('fetch', fetch);
    const events: unknown[] = [];
    await expect(
      f.api.callApiStream(f.endpoint, [], [], (step) => {
        events.push(step);
      }),
    ).resolves.toMatchObject({ content: '合成恢复' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const initial = JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body));
    const retry = JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body));
    const { temperature: _temperature, ...expected } = initial;
    expect(retry).toEqual(expected);
    expect(retry.reasoning_effort).toBe('medium');
    expect(events).toEqual([{ kind: 'text_delta', text: '合成恢复' }]);
    expect(f.usage.getStats()).toMatchObject({
      totalCalls: 2,
      failedCalls: 1,
      totalTokens: 13,
      pendingCalls: 0,
    });
  },
);

it.each([
  { content: '已经输出' },
  { reasoning_content: '已经思考' },
  { tool_calls: [{ index: 0, id: 'synthetic', function: { name: 'synthetic', arguments: '{}' } }] },
])('SSE 已有文本、推理或工具片段后不因温度错误重复生成：%j', async (delta) => {
  const f = fixture();
  const fetch = vi.fn(
    async () =>
      new Response(
        `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: ${JSON.stringify(temperatureError)}\n\n`,
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(f.api.callApiStream(f.endpoint, [], [], () => {})).rejects.toThrow('temperature');
  expect(fetch).toHaveBeenCalledOnce();
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 1, failedCalls: 1 });
});

it('SSE 连续拒绝不重复回退，也不把失败记成成功', async () => {
  const f = fixture();
  const fetch = vi.fn(async () => new Response(`data: ${JSON.stringify(temperatureError)}\n\n`));
  vi.stubGlobal('fetch', fetch);
  await expect(f.api.callApiStream(f.endpoint, [], [], () => {})).rejects.toThrow('temperature');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 2, failedCalls: 2, totalTokens: 2 });
});

it('温度与 reasoning 连续不兼容时各自有界回退，不在后续请求重新附上温度', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(temperatureError), { status: 400 }))
    .mockResolvedValueOnce(
      new Response(
        '{"error":{"param":"reasoning_effort","message":"unsupported reasoning_effort"}}',
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(new Response('data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetch);
  await f.api.callApiStream(f.endpoint, [], [], () => {});
  const bodies = fetch.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
  expect(bodies.map((body) => Object.hasOwn(body, 'temperature'))).toEqual([true, false, false]);
  expect(bodies.map((body) => Object.hasOwn(body, 'reasoning_effort'))).toEqual([
    true,
    true,
    false,
  ]);
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 3, failedCalls: 2 });
});

it('助手标题的 JSON 业务错误回退仍按实际请求数记账并保留功能归属', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(temperatureError)))
    .mockResolvedValueOnce(new Response('{"choices":[{"message":{"content":"合成标题"}}]}'));
  vi.stubGlobal('fetch', fetch);
  await expect(f.api.generateTitle('synthetic', 'synthetic')).resolves.toBe('合成标题');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 2, failedCalls: 1 });
  expect(f.usage.getStats().byFeature[0]?.feature).toBe('assistant-title');
});

it('SSE 温度回退保留原有有界限流退避，不会重新带回温度', async () => {
  const f = fixture();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(temperatureError)}\n\n`))
    .mockResolvedValueOnce(new Response('{"usage":{"total_tokens":0}}', { status: 429 }))
    .mockResolvedValueOnce(new Response(usageEvent + 'data: [DONE]\n\n'));
  vi.stubGlobal('fetch', fetch);
  await f.api.callApiStream(f.endpoint, [], [], () => {});
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(
    fetch.mock.calls.map((call) =>
      Object.hasOwn(JSON.parse(String((call[1] as RequestInit).body)), 'temperature'),
    ),
  ).toEqual([true, false, false]);
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 3, failedCalls: 2, totalTokens: 13 });
});
