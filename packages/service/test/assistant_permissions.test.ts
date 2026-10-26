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
function fixture(run: AssistantTools['run'] = async () => null) {
  const root = mkdtempSync(join(tmpdir(), 'weq-assistant-permissions-'));
  roots.push(root);
  const service = new AssistantService(
    root,
    () => ({ baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', model: 'synthetic' }),
    new TokenUsageStore(join(root, 'usage.json')),
    new ConversationStore(join(root, 'conversation.json')),
    { specs: () => [], run },
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

it.each(['sandbox', 'unrestricted'] as const)(
  'changing %s permission stops an in-flight task instead of escalating or retaining old authority',
  async (initial) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const run = vi.fn<AssistantTools['run']>(async (_name, _args, options) => {
      signal = options?.signal;
      started();
      return new Promise((resolve) =>
        signal?.addEventListener('abort', () => resolve({ calls: [{ state: 'unknown' }] }), {
          once: true,
        }),
      );
    });
    const { service, calls } = fixture(run);
    service.setConfig({ permissionMode: initial, confirmUnrestricted: true });
    const pending = service.chat(service.createSession().id, '合成问题');
    await ready;
    service.setConfig({
      permissionMode: initial === 'sandbox' ? 'unrestricted' : 'sandbox',
      confirmUnrestricted: true,
    });
    const result = await pending;
    expect(signal?.aborted).toBe(true);
    expect(result.text).toContain('未自动重试');
    expect(run.mock.calls[0]?.[2]?.permissionMode).toBe(initial);
    expect(calls).toHaveBeenCalledOnce();
  },
);
