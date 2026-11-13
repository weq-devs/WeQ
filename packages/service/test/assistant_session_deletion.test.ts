// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AssistantService } from '../src/account/assistant';
import { ConversationStore } from '../src/account/agentlab_conversation';
import { TokenUsageStore } from '../src/account/agentlab_usage';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-assistant-delete-'));
  roots.push(root);
  const service = new AssistantService(
    root,
    () => ({ baseUrl: 'https://synthetic.invalid', apiKey: 'synthetic', model: 'synthetic' }),
    new TokenUsageStore(join(root, 'usage.json')),
    new ConversationStore(join(root, 'conversations.json')),
  );
  const internal = service as unknown as {
    runLoop(
      sessionId: string,
      state: unknown,
      emit: (step: { kind: 'text_delta'; text: string }) => void,
      record: unknown,
      signal?: AbortSignal,
    ): Promise<string>;
    generateTitle(): Promise<string>;
  };
  vi.spyOn(internal, 'generateTitle').mockResolvedValue('合成标题');
  return { root, service, internal };
}

describe('助手永久删除', () => {
  it('停止所选运行并等待其写完，未选中的生成继续且删除后不会重生历史', async () => {
    const { root, service, internal } = fixture();
    const selected = service.createSession();
    const unselected = service.createSession();
    const selectedReady = deferred<void>();
    const unselectedReady = deferred<void>();
    const finishSelected = deferred<void>();
    const finishUnselected = deferred<void>();
    const signals = new Map<string, AbortSignal>();
    vi.spyOn(internal, 'runLoop').mockImplementation(async (id, _state, emit, _record, signal) => {
      signals.set(id, signal!);
      emit({ kind: 'text_delta', text: '已生成片段' });
      if (id === selected.id) {
        selectedReady.resolve();
        await finishSelected.promise;
        signal?.throwIfAborted();
      } else {
        unselectedReady.resolve();
        await finishUnselected.promise;
      }
      return '完成的合成回答';
    });
    const chosenRun = service.chat(selected.id, '所选问题');
    const otherRun = service.chat(unselected.id, '保留的问题');
    await Promise.all([selectedReady.promise, unselectedReady.promise]);
    let deleted = false;
    const deletion = service.deleteSessions([selected.id, selected.id]).then(() => {
      deleted = true;
    });
    expect(signals.get(selected.id)?.aborted).toBe(true);
    expect(signals.get(unselected.id)?.aborted).toBe(false);
    expect(deleted).toBe(false);
    expect(service.listSessions().find((item) => item.id === selected.id)?.running).toBe(true);
    await expect(service.chat(selected.id, '删除期间的新问题')).rejects.toThrow('永久删除');
    finishSelected.resolve();
    await Promise.all([chosenRun, deletion]);
    expect(service.listSessions().map((session) => session.id)).toEqual([unselected.id]);
    expect(service.getConversation(selected.id)).toEqual([]);
    expect(existsSync(join(root, 'assistant_runs', `${selected.id}.json`))).toBe(false);
    expect(service.listSessions()[0]?.running).toBe(true);
    finishUnselected.resolve();
    await otherRun;
    expect(service.getConversation(unselected.id).map((turn) => turn.text)).toEqual([
      '保留的问题',
      '完成的合成回答',
    ]);
    expect(service.listSessions()[0]?.running).toBe(false);
  });

  it('删除空会话、已完成会话和不存在的会话均幂等，只清除所选历史', async () => {
    const { service, internal } = fixture();
    vi.spyOn(internal, 'runLoop').mockResolvedValue('合成回答');
    const empty = service.createSession();
    const completed = service.createSession();
    const kept = service.createSession();
    await service.chat(completed.id, '完成的问题');
    await service.chat(kept.id, '保留的问题');
    await service.deleteSessions([empty.id, completed.id, 'missing']);
    await service.deleteSession(completed.id);
    expect(service.listSessions().map((session) => session.id)).toEqual([kept.id]);
    expect(service.getConversation(empty.id)).toEqual([]);
    expect(service.getConversation(completed.id)).toEqual([]);
    expect(service.getConversation(kept.id)).toHaveLength(2);
  });

  it('继续回答也登记为运行，删除等待续答收尾再移除其断点', async () => {
    const { root, service, internal } = fixture();
    const session = service.createSession();
    const interrupted = new AbortController();
    const run = vi.spyOn(internal, 'runLoop').mockImplementation(async () => {
      interrupted.abort();
      interrupted.signal.throwIfAborted();
      return '';
    });
    await service.chat(session.id, '被中断的问题', undefined, interrupted.signal);
    expect(service.getResumeState(session.id).resumable).toBe(true);
    const started = deferred<void>();
    const finish = deferred<void>();
    let resumeSignal: AbortSignal | undefined;
    run.mockImplementation(async (_id, _state, _emit, _record, signal) => {
      resumeSignal = signal;
      started.resolve();
      await finish.promise;
      signal?.throwIfAborted();
      return '续答内容';
    });
    const continuation = service.resumeAssistantRun(session.id);
    await started.promise;
    const deletion = service.deleteSession(session.id);
    expect(resumeSignal?.aborted).toBe(true);
    expect(service.listSessions()[0]?.running).toBe(true);
    finish.resolve();
    await Promise.all([continuation, deletion]);
    expect(service.listSessions()).toEqual([]);
    expect(service.getConversation(session.id)).toEqual([]);
    expect(service.getResumeState(session.id).resumable).toBe(false);
    expect(existsSync(join(root, 'assistant_runs', `${session.id}.json`))).toBe(false);
  });
});
