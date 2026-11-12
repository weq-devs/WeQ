import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useSharedAssistantDraft } from '../src/renderer/src/hooks/useSharedAssistantDraft';
import {
  isAssistantSessionDeleted,
  markAssistantSessionDeleted,
  readAssistantDraft,
  readAssistantSession,
  rememberAssistantDraft,
  rememberAssistantSession,
} from '../src/renderer/src/lib/assistantWorkspace';

const fixture = vi.hoisted(() => ({
  binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
  read: vi.fn(),
  save: vi.fn(),
  error: vi.fn(),
  input: vi.fn(),
  retries: new Map<string, () => void | Promise<void>>(),
  sequence: 0,
}));
vi.mock('../src/renderer/src/lib/clientPreferences', () => ({
  accountBinding: () => fixture.binding,
  currentAccountScope: () =>
    JSON.stringify([fixture.binding.expectedAccountUin, fixture.binding.expectedAccountConfigId]),
  useClientPreferences: { setState: fixture.error },
  rememberClientRetry: (key: string, run: () => void | Promise<void>) =>
    fixture.retries.set(key, run),
  forgetClientRetry: (key: string) => fixture.retries.delete(key),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { clientState: { draft: { query: fixture.read }, saveDraft: { mutate: fixture.save } } },
}));

function scope() {
  return JSON.stringify([
    fixture.binding.expectedAccountUin,
    fixture.binding.expectedAccountConfigId,
  ]);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function Harness({ id, value }: { id: string; value: string }) {
  useSharedAssistantDraft(`assistant:${id}`, value, fixture.input, true);
  return null;
}
async function mount(ids = ['selected']) {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => {
    root.render(
      h(
        'div',
        null,
        ids.map((id) => h(Harness, { key: id, id, value: `${id}未发送的合成输入` })),
      ),
    );
    await Promise.resolve();
  });
  return { dispose: () => act(() => root.unmount()) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.binding = {
    expectedAccountUin: '10001',
    expectedAccountConfigId: `source-${++fixture.sequence}`,
  };
  fixture.read.mockReset().mockResolvedValue({ version: null, value: '' });
  fixture.save.mockReset().mockImplementation(async (input: { value: unknown }) => ({
    ok: true,
    current: { version: 'saved', value: input.value },
  }));
  fixture.error.mockReset();
  fixture.input.mockReset();
  fixture.retries.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('助手永久删除的本地输入收尾', () => {
  it('精确清除所删会话的草稿、base及重试，不碰同账号其他会话或其他账号', () => {
    const account = scope();
    const other = 'different-account';
    rememberAssistantDraft(account, 'selected', '将被删除');
    rememberAssistantDraft(account, 'kept', '保留');
    rememberAssistantDraft(other, 'selected', '其他账号原稿');
    rememberAssistantSession(account, 'selected');
    localStorage.setItem(`weq.sync.draft-base:${account}:assistant:selected`, 'selected-base');
    localStorage.setItem(`weq.sync.draft-base:${account}:assistant:kept`, 'kept-base');
    const deletedRetry = `assistant:${account}:assistant:selected`;
    const otherRetry = `assistant:${account}:assistant:kept`;
    fixture.retries.set(deletedRetry, vi.fn());
    fixture.retries.set(otherRetry, vi.fn());
    markAssistantSessionDeleted(account, 'selected');
    expect(readAssistantDraft(account, 'selected')).toBe('');
    expect(readAssistantSession(account)).toBeNull();
    expect(localStorage.getItem(`weq.sync.draft-base:${account}:assistant:selected`)).toBeNull();
    expect(localStorage.getItem(`weq.sync.draft-base:${account}:assistant:kept`)).toBe('kept-base');
    expect(readAssistantDraft(account, 'kept')).toBe('保留');
    expect(readAssistantDraft(other, 'selected')).toBe('其他账号原稿');
    expect(fixture.retries.has(deletedRetry)).toBe(false);
    expect(fixture.retries.has(otherRetry)).toBe(true);
    rememberAssistantDraft(account, 'selected', '迟到输入');
    rememberAssistantSession(account, 'selected');
    expect(readAssistantDraft(account, 'selected')).toBe('');
    expect(readAssistantSession(account)).toBeNull();
  });

  it('删除后卸载不会flush旧输入，也不产生新的重试或错误', async () => {
    const f = await mount();
    markAssistantSessionDeleted(scope(), 'selected');
    f.dispose();
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.retries.size).toBe(0);
    expect(fixture.error).not.toHaveBeenCalled();
  });

  it('删除后的保存定时器跳过所删会话，同账号未选中输入仍正常保存', async () => {
    const f = await mount(['selected', 'kept']);
    try {
      markAssistantSessionDeleted(scope(), 'selected');
      await act(async () => vi.advanceTimersByTimeAsync(901));
      expect(fixture.save).toHaveBeenCalledOnce();
      expect(fixture.save).toHaveBeenCalledWith(expect.objectContaining({ key: 'assistant:kept' }));
      expect(fixture.error).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it('删除期间在途保存迟到成功不重新写入base或登记重试', async () => {
    const response = deferred<{ ok: boolean; current: { version: string; value: string } }>();
    fixture.save.mockImplementationOnce(() => response.promise);
    const f = await mount();
    try {
      await act(async () => vi.advanceTimersByTimeAsync(901));
      expect(fixture.save).toHaveBeenCalledOnce();
      markAssistantSessionDeleted(scope(), 'selected');
      await act(async () =>
        response.resolve({ ok: true, current: { version: 'late', value: '迟到的旧输入' } }),
      );
      expect(localStorage.getItem(`weq.sync.draft-base:${scope()}:assistant:selected`)).toBeNull();
      expect(fixture.retries.size).toBe(0);
      expect(fixture.error).not.toHaveBeenCalled();
      expect(fixture.input).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });

  it('删除后迟到的共享读取不恢复旧输入，不因无关账号的同名会话被删除而拦截', async () => {
    const response = deferred<{ version: string; value: string }>();
    fixture.read.mockImplementationOnce(() => response.promise);
    const f = await mount();
    try {
      markAssistantSessionDeleted(scope(), 'selected');
      await act(async () => response.resolve({ version: 'old', value: '旧的共享输入' }));
      expect(fixture.input).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTimeAsync(901));
      expect(fixture.save).not.toHaveBeenCalled();
      expect(isAssistantSessionDeleted('unrelated-account', 'selected')).toBe(false);
    } finally {
      f.dispose();
    }
  });
});
