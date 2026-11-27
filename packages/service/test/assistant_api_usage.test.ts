import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentLabEndpoint, AgentLabModelSelection } from '@weq/agentlab';
import { AssistantService } from '../src/account/assistant';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import { UNKNOWN_NETWORK } from '../src/common/data_saver';
import { updateTransferPolicy } from '../src/common/transfer_policy';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(resolve?: (ref: AgentLabModelSelection) => AgentLabEndpoint) {
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
    resolve ?? (() => endpoint),
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
  return { usage, endpoint, api, service, dir };
}
const usageEvent =
  'data: {"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n';

it('省流量下助手完成手动提问，只用首条提问命名会话', async () => {
  const { service } = fixture();
  const fetch = vi.fn(
    async () =>
      new Response('data: {"choices":[{"delta":{"content":"合成回答"}}]}\n\ndata: [DONE]\n\n'),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    updateTransferPolicy('always', UNKNOWN_NETWORK);
    const session = service.createSession();
    await expect(service.chat(session.id, '首条问题')).resolves.toMatchObject({ text: '合成回答' });
    expect(service.listSessions()[0]).toMatchObject({ title: '首条问题', titlePending: false });
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    service.cancelPendingTitles();
    updateTransferPolicy('auto', UNKNOWN_NETWORK);
  }
});

it('助手的服务商时限覆盖流式正文，超时记失败且不重发', async () => {
  const f = fixture();
  const fetch = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
              once: true,
            });
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(
    f.api.callApiStream({ ...f.endpoint, timeoutMs: 25 }, [], [], () => {}),
  ).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(fetch).toHaveBeenCalledOnce();
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 1, failedCalls: 1 });
});

it('输出参数的400错误不被误判为思考参数不兼容，也不污染后续请求', async () => {
  const f = fixture();
  const calls = vi
    .fn<(_url: unknown, _input?: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(
      new Response(
        '{"error":{"param":"max_tokens","message":"max_tokens exceeds the model limit"}}',
        { status: 400 },
      ),
    )
    .mockResolvedValueOnce(new Response(usageEvent + 'data: [DONE]\n\n'));
  vi.stubGlobal('fetch', calls);
  await expect(f.api.callApiStream(f.endpoint, [], [], () => {})).rejects.toThrow('max_tokens');
  await f.api.callApiStream(f.endpoint, [], [], () => {});
  expect(calls).toHaveBeenCalledTimes(2);
  expect(
    calls.mock.calls.map((args) => JSON.parse(String(args[1]?.body)).reasoning_effort),
  ).toEqual(['medium', 'medium']);
});

it('助手默认引用持久化并在调用时解析，模型变更无需重写账号配置', async () => {
  let model = 'first';
  const resolve = (ref: AgentLabModelSelection): AgentLabEndpoint => ({
    baseUrl: 'https://synthetic.invalid',
    apiKey: 'synthetic',
    model: 'useDefault' in ref ? model : ref.model,
  });
  const f = fixture(resolve);
  f.service.setConfig({ model: { useDefault: true } });
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, input?: RequestInit) => {
      calls.push(JSON.parse(String(input?.body)).model);
      return new Response(JSON.stringify({ choices: [{ message: { content: '合成标题' } }] }));
    }),
  );
  await f.api.generateTitle('合成问题', '合成回复');
  model = 'second';
  await f.api.generateTitle('合成问题', '合成回复');
  expect(calls).toEqual(['first', 'second']);
  const reopened = new AssistantService(
    f.dir,
    resolve,
    f.usage,
    new ConversationStore(join(f.dir, 'conversations.json')),
  );
  expect(reopened.getConfig().model).toEqual({ useDefault: true });
  const empty = new AssistantService(
    join(f.dir, 'empty'),
    resolve,
    f.usage,
    new ConversationStore(join(f.dir, 'empty-conversations.json')),
  );
  expect(empty.getConfig().model).toEqual({ useDefault: true });
  writeFileSync(join(f.dir, 'assistant.json'), JSON.stringify({ model: null }));
  const legacy = new AssistantService(
    f.dir,
    resolve,
    f.usage,
    new ConversationStore(join(f.dir, 'legacy-conversations.json')),
  );
  expect(legacy.getConfig().model).toEqual({ useDefault: true });
});

it('助手不支持思考参数的记忆按实际模型隔离，切换默认模型后重新尝试', async () => {
  const f = fixture();
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, input?: RequestInit) => {
      bodies.push(JSON.parse(String(input?.body)));
      return bodies.length === 1
        ? new Response(
            '{"error":{"param":"reasoning_effort","message":"unsupported reasoning_effort"}}',
            { status: 400 },
          )
        : new Response('data: [DONE]\n\n');
    }),
  );
  await f.api.callApiStream(f.endpoint, [], [], () => {});
  await f.api.callApiStream({ ...f.endpoint, model: 'another' }, [], [], () => {});
  await f.api.callApiStream(f.endpoint, [], [], () => {});
  expect(bodies.map((body) => body.reasoning_effort)).toEqual([
    'medium',
    undefined,
    'medium',
    undefined,
  ]);
});

it('助手流式重复 usage 不重复计数，400／429 的真实重试独立留账', async () => {
  const f = fixture();
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      calls++;
      if (calls === 1)
        return new Response(
          '{"error":{"param":"reasoning_effort","message":"unsupported reasoning_effort"}}',
          { status: 400 },
        );
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
  '助手不发送旧温度参数，%s 错误不重发且只记一次费用',
  async (kind) => {
    const f = fixture();
    const first =
      kind === 'sse'
        ? new Response(`data: ${JSON.stringify(temperatureError)}\n\n`)
        : new Response(JSON.stringify(temperatureError), {
            status: kind === 'http' ? 400 : 200,
            headers: kind === 'json' ? { 'content-type': 'application/json' } : undefined,
          });
    const fetch = vi.fn(async (_url: unknown, _init: RequestInit) => first);
    vi.stubGlobal('fetch', fetch);
    await expect(f.api.callApiStream(f.endpoint, [], [], () => {})).rejects.toThrow('temperature');
    expect(fetch).toHaveBeenCalledOnce();
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1].body));
    expect(body).not.toHaveProperty('temperature');
    expect(body.reasoning_effort).toBe('medium');
    expect(f.usage.getStats()).toMatchObject({
      totalCalls: 1,
      failedCalls: 1,
      totalTokens: 1,
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

it('助手标题未请求固定输出预算时不补上限，且保留功能归属', async () => {
  const f = fixture();
  f.endpoint.requestProperties = { maxOutputTokens: 7 };
  const fetch = vi.fn(
    async (_url: unknown, _init: RequestInit) =>
      new Response('{"choices":[{"message":{"content":"合成标题"}}]}'),
  );
  vi.stubGlobal('fetch', fetch);
  await expect(f.api.generateTitle('synthetic', 'synthetic')).resolves.toBe('合成标题');
  expect(fetch).toHaveBeenCalledOnce();
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).not.toHaveProperty('max_tokens');
  expect(f.usage.getStats()).toMatchObject({ totalCalls: 1, failedCalls: 0 });
  expect(f.usage.getStats().byFeature[0]?.feature).toBe('assistant-title');
});
