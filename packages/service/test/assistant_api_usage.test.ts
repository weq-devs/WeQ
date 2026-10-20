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
      emit: () => void,
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
