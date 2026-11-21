import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AssistantService, type AssistantTools } from '../src/account/assistant';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(run: AssistantTools['run'] = async () => null, localModel?: string) {
  const root = mkdtempSync(join(tmpdir(), 'weq-assistant-permissions-'));
  roots.push(root);
  const service = new AssistantService(
    root,
    () =>
      localModel
        ? {
            baseUrl: 'http://127.0.0.1:8000/v1',
            apiKey: 'synthetic',
            model: localModel,
            providerVendor: 'omlx',
          }
        : { baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', model: 'synthetic' },
    new TokenUsageStore(join(root, 'usage.json')),
    new ConversationStore(join(root, 'conversation.json')),
    {
      specs: (options) =>
        (options?.names ?? []).map((name) => ({
          type: 'function',
          function: { name, description: '', parameters: {} },
        })),
      run,
      isReadOnly: (name) => ['find_contact', 'list_group_files', 'get_feature'].includes(name),
    },
  );
  service.setConfig({ model: { providerId: 'synthetic', model: 'synthetic' } });
  const api = service as unknown as {
    callApiStream: (...args: unknown[]) => Promise<{
      content: string;
      toolCalls?: { id: string; function: { name: string; arguments: string } }[];
    }>;
    generateTitle: (...args: unknown[]) => Promise<string>;
  };
  vi.spyOn(api, 'generateTitle').mockResolvedValue('合成标题');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('测试禁止外部请求');
    }),
  );
  const calls = vi.spyOn(api, 'callApiStream').mockResolvedValue({
    content: '',
    toolCalls: [
      { id: 'first', function: { name: 'synthetic', arguments: '{}' } },
      { id: 'second', function: { name: 'synthetic', arguments: '{}' } },
    ],
  });
  return { service, calls, root };
}

it('defaults to sandbox and refuses unacknowledged unrestricted activation', () => {
  const { service } = fixture();
  expect(service.getConfig().permissionMode).toBe('sandbox');
  expect(() => service.setConfig({ permissionMode: 'unrestricted' })).toThrow(
    '删除 WeQ 目录之外的文件',
  );
  expect(service.getConfig().permissionMode).toBe('sandbox');
  service.setConfig({ permissionMode: 'unrestricted', confirmUnrestricted: true });
  expect(service.getConfig().permissionMode).toBe('unrestricted');
  service.setConfig({ permissionMode: 'sandbox' });
  expect(() => service.setConfig({ permissionMode: 'unrestricted' })).toThrow();
});

it('本地轻量模式普通对话不附工具，精确范围查询直接引用工具结果', async () => {
  const run = vi.fn<AssistantTools['run']>(async () => ({
    navigation: { featureId: 'setting:llm-default-model' },
  }));
  const { service, calls } = fixture(run, 'unverified-local');
  service.setConfig({ localLightweight: true });
  calls.mockResolvedValue({ content: '合成答案' });
  await service.chat(service.createSession().id, '什么是周报？');
  expect(calls.mock.calls[0]?.[2]).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  await service.chat(service.createSession().id, '默认聊天模型在哪里设置');
  expect(run).toHaveBeenCalledWith(
    'get_feature',
    { id: 'setting:llm-default-model' },
    expect.anything(),
  );
  expect(calls.mock.calls[1]?.[2]).toEqual([]);
  expect(JSON.stringify(calls.mock.calls[1]?.[1])).toContain('WeQ 的查询结果');
});

it('轻量模式的同名群必须先确认，模型的坏参数不能变成空对象执行', async () => {
  const run = vi.fn<AssistantTools['run']>(async (name) =>
    name === 'find_contact'
      ? {
          groups: [
            { groupCode: '12345', groupName: '测试群' },
            { groupCode: '54321', groupName: '测试群' },
          ],
        }
      : { navigation: { featureId: 'setting:llm-default-model' } },
  );
  const { service, calls } = fixture(run, 'Qwen3.6-35B-A3B-4bit');
  service.setConfig({ localLightweight: true });
  const choice = await service.chat(service.createSession().id, '查看测试群文件');
  expect(choice.text).toContain('12345、54321');
  expect(run).toHaveBeenCalledTimes(1);
  expect(calls).not.toHaveBeenCalled();
  calls
    .mockResolvedValueOnce({
      content: '',
      toolCalls: [{ id: 'invalid', function: { name: 'get_feature', arguments: '{bad' } }],
    })
    .mockResolvedValueOnce({ content: '合成答案' });
  await service.chat(service.createSession().id, '默认聊天模型在哪里设置');
  expect(calls.mock.calls[0]?.[2]).toEqual([
    expect.objectContaining({ function: expect.objectContaining({ name: 'get_feature' }) }),
  ]);
  expect(run.mock.calls[1]?.slice(0, 2)).toEqual([
    'get_feature',
    { id: 'setting:llm-default-model' },
  ]);
  expect(calls.mock.calls[1]?.[2]).toEqual([]);
});

it.each(['null', '[]', '42', '"text"'])(
  'preserves invalid assistant configuration %s instead of overwriting it',
  (content) => {
    const { root } = fixture();
    const path = join(root, 'assistant.json');
    writeFileSync(path, content);
    expect(
      () =>
        new AssistantService(
          root,
          () => ({ baseUrl: 'https://synthetic.invalid', apiKey: '', model: 'synthetic' }),
          new TokenUsageStore(join(root, 'usage.json')),
          new ConversationStore(join(root, 'conversation.json')),
        ),
    ).toThrow('原件');
    expect(readFileSync(path, 'utf8')).toBe(content);
  },
);

it('stops rather than letting the model retry an unknown sandbox outcome or execute sibling calls', async () => {
  const run = vi.fn<AssistantTools['run']>(async () => ({
    ok: false,
    calls: [{ state: 'unknown' }],
  }));
  const { service, calls } = fixture(run);
  const session = service.createSession();
  const result = await service.chat(session.id, '合成问题');
  expect(result.text).toContain('未自动重试');
  expect(run).toHaveBeenCalledOnce();
  expect(calls).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]?.[2]).toMatchObject({ permissionMode: 'sandbox' });
});

it('outer tool timeout aborts the execution signal and ends the turn without retrying', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const run = vi.fn<AssistantTools['run']>(async (_name, _args, options) => {
    signal = options?.signal;
    return new Promise(() => {});
  });
  const { service, calls } = fixture(run);
  const pending = service.chat(service.createSession().id, '合成问题');
  await vi.advanceTimersByTimeAsync(61_000);
  const result = await pending;
  expect(signal?.aborted).toBe(true);
  expect(result.text).toContain('未自动重试');
  expect(run).toHaveBeenCalledOnce();
  expect(calls).toHaveBeenCalledOnce();
});

it('stopping an in-flight tool leaves a resumable checkpoint instead of a final answer', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const run = vi.fn<AssistantTools['run']>(async () => {
    started();
    return new Promise(() => {});
  });
  const { service, calls } = fixture(run);
  const sessionId = service.createSession().id;
  const controller = new AbortController();
  const pending = service.chat(sessionId, '合成问题', undefined, controller.signal);
  await ready;
  controller.abort();

  const result = await pending;
  expect(result.steps.at(-1)).toMatchObject({ kind: 'aborted' });
  expect(service.getResumeState(sessionId).resumable).toBe(true);
  expect(run.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  expect(run).toHaveBeenCalledOnce();
  expect(calls).toHaveBeenCalledOnce();
});

it.each(['sandbox', 'unrestricted'] as const)(
  'changing %s permission applies to the next task and preserves the current task snapshot',
  async (initial) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    const run = vi.fn<AssistantTools['run']>(async (_name, _args, options) => {
      signal = options?.signal;
      started();
      return new Promise((resolve) => {
        finish = () => resolve({ calls: [{ state: 'unknown' }] });
        signal?.addEventListener('abort', finish, {
          once: true,
        });
      });
    });
    const { service, calls } = fixture(run);
    service.setConfig({ permissionMode: initial, confirmUnrestricted: true });
    const pending = service.chat(service.createSession().id, '合成问题');
    await ready;
    service.setConfig({
      permissionMode: initial === 'sandbox' ? 'unrestricted' : 'sandbox',
      confirmUnrestricted: true,
    });
    expect(signal?.aborted).toBe(false);
    expect(service.getConfig().permissionMode).not.toBe(initial);
    finish();
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.text).toContain('未自动重试');
    expect(run.mock.calls[0]?.[2]?.permissionMode).toBe(initial);
    expect(calls).toHaveBeenCalledOnce();
  },
);
