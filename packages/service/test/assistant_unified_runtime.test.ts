import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantService, type AssistantTaskEvent } from '../src/account/assistant';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';
import { AssistantQueue } from '../src/account/assistant_queue';
import { ASSISTANT_PARAMETER_DEFAULTS } from '../src/account/assistant_config';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const sse = (delta: object) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const response = (text: string) => new Response(sse({ content: text }) + 'data: [DONE]\n\n');
function fixture(
  tools?: ConstructorParameters<typeof AssistantService>[4],
  resolve?: ConstructorParameters<typeof AssistantService>[1],
) {
  const dir = mkdtempSync(join(tmpdir(), 'weq-assistant-unified-'));
  dirs.push(dir);
  const create = () =>
    new AssistantService(
      dir,
      resolve ??
        (() => ({ baseUrl: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture' })),
      new TokenUsageStore(join(dir, 'usage.json')),
      new ConversationStore(join(dir, 'conversation.json')),
      tools,
    );
  const service = create();
  service.setConfig({ model: { providerId: 'fixture', model: 'fixture' } });
  const session = service.createSession();
  const initialTitle = session.title;
  const sessionId = session.id;
  service.renameSession(sessionId, '合成会话');
  const events: AssistantTaskEvent[] = [];
  const submit = (
    requestId: string,
    text: string,
    mode: 'interrupt' | 'boundary' | 'queue' = 'interrupt',
  ) => service.submitMessage({ requestId, sessionId, text, mode }, (event) => events.push(event));
  return { dir, create, service, sessionId, initialTitle, events, submit };
}
it('立即补充打断单次生成，按时间分段落库且不重复受理同一请求', async () => {
  const f = fixture();
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls > 1) return response('补充后的回答');
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse({ content: '已有片段' })));
            init?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('interrupted', 'AbortError')),
              { once: true },
            );
          },
        }),
      );
    }),
  );
  f.submit('first', '原问题');
  await vi.waitFor(() =>
    expect(f.events.some((event) => event.step.kind === 'text_delta')).toBe(true),
  );
  const accepted = f.submit('second', '补充条件');
  expect(f.submit('second', '补充条件').messageId).toBe(accepted.messageId);
  await vi.waitFor(() => expect(f.service.getQueue(f.sessionId).running).toBe(false));
  expect(f.service.getConversation(f.sessionId).map((turn) => [turn.role, turn.text])).toEqual([
    ['user', '原问题'],
    ['assistant', '已有片段'],
    ['user', '补充条件'],
    ['assistant', '补充后的回答'],
  ]);
  expect(new Set(f.service.getConversation(f.sessionId).map((turn) => turn.id)).size).toBe(4);
  expect(calls).toBe(2);
});
it('下一步补充不打断正在生成的请求，但最终返回前仍会处理补充', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  let aborted = false;
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls++;
      if (calls > 1) return response('后续回答');
      init?.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(
                new TextEncoder().encode(sse({ content: '原回答' }) + 'data: [DONE]\n\n'),
              );
              controller.close();
            };
          },
        }),
      );
    }),
  );
  f.submit('a', '问题');
  await vi.waitFor(() => expect(release).toBeDefined());
  f.submit('b', '下一步条件', 'boundary');
  expect(aborted).toBe(false);
  release!();
  await vi.waitFor(() => expect(f.service.getQueue(f.sessionId).running).toBe(false));
  expect(f.service.getConversation(f.sessionId).map((turn) => turn.text)).toEqual([
    '问题',
    '原回答',
    '下一步条件',
    '后续回答',
  ]);
});
it('工具执行中补充保留已开始的结果，尚未执行的同批工具不会重放', async () => {
  let finish: (() => void) | undefined;
  const run = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { ok: true };
  });
  const f = fixture({
    specs: () => [
      {
        type: 'function',
        function: { name: 'read_fixture', description: 'fixture', parameters: {} },
      },
    ],
    run,
  });
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      ++calls === 1
        ? new Response(
            sse({
              tool_calls: [
                {
                  index: 0,
                  id: 'tool-a',
                  type: 'function',
                  function: { name: 'read_fixture', arguments: '{}' },
                },
                {
                  index: 1,
                  id: 'tool-b',
                  type: 'function',
                  function: { name: 'read_fixture', arguments: '{}' },
                },
              ],
            }) + 'data: [DONE]\n\n',
          )
        : response('完成'),
    ),
  );
  f.submit('a', '查资料');
  await vi.waitFor(() => expect(finish).toBeDefined());
  f.submit('b', '改变方向');
  finish!();
  await vi.waitFor(() => expect(f.service.getQueue(f.sessionId).running).toBe(false));
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    f.service
      .getConversation(f.sessionId)
      .filter((turn) => turn.role === 'user')
      .map((turn) => turn.text),
  ).toEqual(['查资料', '改变方向']);
});
it('当前任务使用参数快照，队列中的下一项独立任务读取新参数', async () => {
  const f = fixture();
  const bodies: Array<Record<string, unknown>> = [];
  let release: (() => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length > 1) return response('完成');
      return new Response(
        new ReadableStream({
          start(controller) {
            release = () => {
              controller.enqueue(
                new TextEncoder().encode(sse({ content: '第一项' }) + 'data: [DONE]\n\n'),
              );
              controller.close();
            };
          },
        }),
      );
    }),
  );
  f.submit('a', '问题');
  await vi.waitFor(() => expect(release).toBeDefined());
  f.service.setConfig({ temperature: 1.4, reasoningEffort: 'high', maxOutputTokens: 1234 });
  f.submit('b', '下一项', 'queue');
  release!();
  await vi.waitFor(() => expect(bodies).toHaveLength(2));
  await vi.waitFor(() => expect(f.service.getQueue(f.sessionId).running).toBe(false));
  expect(bodies[0]?.temperature).toBe(ASSISTANT_PARAMETER_DEFAULTS.temperature);
  expect(bodies[1]).toMatchObject({ temperature: 1.4, reasoning_effort: 'high', max_tokens: 1234 });
});
it('失败会暂停队列，重开保留待办，编辑和取消不会执行任务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-assistant-queue-'));
  dirs.push(dir);
  let fail: (() => void) | undefined;
  const execute = vi.fn(async (_item: unknown, _signal: AbortSignal, started: () => void) => {
    started();
    await new Promise<void>((resolve) => {
      fail = resolve;
    });
    throw new Error('合成错误');
  });
  const host = { execute, supplement: () => false, changed: () => {} };
  const queue = new AssistantQueue(join(dir, 'queue.json'), host);
  queue.submit({ requestId: 'a', sessionId: 's', text: '第一项', mode: 'queue' });
  await vi.waitFor(() => expect(fail).toBeDefined());
  queue.submit({ requestId: 'b', sessionId: 's', text: '第二项', mode: 'queue' });
  fail!();
  await vi.waitFor(() => expect(queue.get('s').paused).toBe(true));
  expect(execute).toHaveBeenCalledTimes(1);
  const reopened = new AssistantQueue(join(dir, 'queue.json'), host);
  expect(reopened.get('s')).toMatchObject({
    paused: true,
    running: false,
    items: [{ requestId: 'b' }],
  });
  reopened.edit('s', 'b', { text: '已编辑' });
  expect(reopened.get('s').items[0]?.text).toBe('已编辑');
  reopened.edit('s', 'b', { cancel: true });
  expect(reopened.get('s').items).toEqual([]);
});
function heldResponse(init?: RequestInit, initial = '') {
  let closed = false;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream = controller;
      if (initial) controller.enqueue(new TextEncoder().encode(sse({ content: initial })));
      init?.signal?.addEventListener(
        'abort',
        () => {
          closed = true;
          controller.error(new DOMException('stopped', 'AbortError'));
        },
        { once: true },
      );
    },
  });
  return {
    response: new Response(body),
    finish(text: string) {
      if (!closed && stream) {
        stream.enqueue(new TextEncoder().encode(sse({ content: text }) + 'data: [DONE]\n\n'));
        stream.close();
        closed = true;
      }
    },
  };
}
it('发送不带模式覆盖时使用应用默认，重试不因默认改变而重新受理', async () => {
  const f = fixture();
  let first: ReturnType<typeof heldResponse> | undefined;
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (++calls === 1) {
        first = heldResponse(init);
        return first.response;
      }
      return response('下一项完成');
    }),
  );
  f.submit('a', '第一项');
  await vi.waitFor(() => expect(first).toBeDefined());
  try {
    f.service.setConfig({ sendMode: 'queue' });
    f.service.submitMessage({ requestId: 'b', sessionId: f.sessionId, text: '第二项' });
    f.service.setConfig({ sendMode: 'interrupt' });
    f.service.submitMessage({ requestId: 'b', sessionId: f.sessionId, text: '第二项' });
    expect(
      f.service.getQueue(f.sessionId).items.filter((item) => item.requestId === 'b'),
    ).toMatchObject([{ mode: 'queue' }]);
    first!.finish('第一项完成');
    await vi.waitFor(() => expect(f.service.getQueue(f.sessionId).running).toBe(false));
    expect(
      f.service
        .getConversation(f.sessionId)
        .filter((turn) => turn.role === 'user')
        .map((turn) => turn.text),
    ).toEqual(['第一项', '第二项']);
    expect(calls).toBe(2);
  } finally {
    f.service.stopSession(f.sessionId);
  }
});
it('外部取消会暂停队列，重开后可继续当前任务，不重发已受理的用户消息', async () => {
  const f = fixture();
  let first: ReturnType<typeof heldResponse> | undefined;
  let active: AbortController | null = null;
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (++calls === 1) {
        first = heldResponse(init, '未完成的片段');
        return first.response;
      }
      return response('恢复后的回答');
    }),
  );
  f.service.submitMessage(
    { requestId: 'a', sessionId: f.sessionId, text: '第一项', mode: 'interrupt' },
    (event) => f.events.push(event),
    (_id, controller) => {
      active = controller;
    },
  );
  await vi.waitFor(() => expect(first).toBeDefined());
  f.submit('b', '第二项', 'queue');
  active!.abort();
  await vi.waitFor(() => expect(f.service.getQueue(f.sessionId).running).toBe(false));
  expect(f.service.getQueue(f.sessionId)).toMatchObject({
    paused: true,
    items: [{ requestId: 'b' }],
  });
  const reopened = f.create();
  expect(reopened.getResumeState(f.sessionId).resumable).toBe(true);
  reopened.continueSession(f.sessionId, () => {});
  await vi.waitFor(() => expect(reopened.getQueue(f.sessionId).running).toBe(false));
  expect(
    reopened
      .getConversation(f.sessionId)
      .filter((turn) => turn.role === 'user')
      .map((turn) => turn.text),
  ).toEqual(['第一项', '第二项']);
  expect(calls).toBe(3);
});
it('默认模型在任务内解析一次，标题生成也沿用启动模型，下一项才采用新默认', async () => {
  let model = 'first-model';
  const f = fixture(undefined, () => ({
    baseUrl: 'https://fixture.invalid',
    apiKey: 'fixture',
    model,
  }));
  f.service.setConfig({ model: { useDefault: true } });
  f.service.renameSession(f.sessionId, f.initialTitle);
  let first: ReturnType<typeof heldResponse> | undefined;
  const models: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
      models.push(body.model);
      if (!body.stream)
        return new Response(
          JSON.stringify({ choices: [{ message: { content: '合成自动标题' } }] }),
        );
      if (models.length === 1) {
        first = heldResponse(init);
        return first.response;
      }
      return response('下一项');
    }),
  );
  f.submit('a', '第一项');
  await vi.waitFor(() => expect(first).toBeDefined());
  model = 'second-model';
  f.submit('b', '第二项', 'queue');
  first!.finish('第一项完成');
  await vi.waitFor(() => expect(f.service.getQueue(f.sessionId).running).toBe(false));
  expect(models).toEqual(['first-model', 'first-model', 'second-model']);
});
it('取消的队列消息保留幂等回执，重试不会把它重新加入队列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'weq-assistant-cancel-'));
  dirs.push(dir);
  let release: (() => void) | undefined;
  const execute = vi.fn(async (_item: unknown, _signal: AbortSignal, started: () => void) => {
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const queue = new AssistantQueue(join(dir, 'queue.json'), {
    execute,
    supplement: () => false,
    changed: () => {},
  });
  queue.submit({ requestId: 'a', sessionId: 's', text: '第一项', mode: 'queue' });
  await vi.waitFor(() => expect(release).toBeDefined());
  const pending = { requestId: 'b', sessionId: 's', text: '第二项', mode: 'queue' as const };
  queue.submit(pending);
  queue.edit('s', 'b', { cancel: true });
  expect(queue.submit(pending).status).toBe('done');
  release!();
  await vi.waitFor(() => expect(queue.get('s').running).toBe(false));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(queue.get('s').items).toEqual([]);
});

it('参数验证拒绝无效组合，明确区分不限制与模型默认', () => {
  const f = fixture();
  expect(() => f.service.setConfig({ compressionTarget: 0.9 })).toThrow('压缩目标');
  expect(() => f.service.setConfig({ maxRounds: 0 })).toThrow();
  f.service.setConfig({
    maxRounds: null,
    toolTimeoutMs: null,
    taskTimeoutMs: null,
    maxOutputTokens: null,
  });
  expect(f.service.getConfig()).toMatchObject({ maxRounds: null, maxOutputTokens: null });
});
