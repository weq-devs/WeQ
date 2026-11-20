import { act, createElement, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceDrafts } from '../src/renderer/src/views/workspace/useWorkspaceDrafts';
import { composerDraftRecovery } from '../src/renderer/src/lib/composerDraftRecovery';
import { createTemplateDemoData } from './support/templateDemoData';

const f = vi.hoisted(() => ({
  rows: undefined as Array<{ targetUid: string; version: string; elements: unknown[] }> | undefined,
  save: vi.fn(),
  share: vi.fn(async (_account: string, _conversation: string, body: string) => body),
  notify: vi.fn(),
  retry: vi.fn(),
  forget: vi.fn(),
  preferenceError: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { listDrafts: { useQuery: () => ({ data: f.rows }) } } },
  client: { account: { saveDraft: { mutate: f.save } } },
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => f.notify }));
vi.mock('../src/renderer/src/components/Toast.shared', () => ({ useToast: () => f.notify }));
vi.mock('../src/renderer/src/lib/accountFilePicker', () => ({ stageAccountFile: vi.fn() }));
vi.mock('../src/renderer/src/lib/notificationNavigation', () => ({
  notificationSource: (value: unknown) => value,
  conversationNotificationSource: (value: unknown) => value,
}));
vi.mock('../src/renderer/src/lib/notificationNavigation.shared', () => ({
  notificationSource: (value: unknown) => value,
  conversationNotificationSource: (value: unknown) => value,
}));
vi.mock('../src/renderer/src/lib/composerDraftMedia', () => ({
  composerAssetIds: () => new Set(),
  removeUnusedComposerImages: vi.fn(),
  shareComposerImages: f.share,
}));
vi.mock('../src/renderer/src/lib/clientPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/clientPreferences')>()),
  accountBinding: () => null,
  rememberClientRetry: f.retry,
  forgetClientRetry: f.forget,
}));

type Input = Parameters<typeof useWorkspaceDrafts>[0];
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.clearAllMocks();
  f.rows = undefined;
  f.save.mockImplementation(async (input) => ({
    ok: true,
    current: { version: 'saved', value: input.elements },
  }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
});

async function fixture(strict = false) {
  const demo = createTemplateDemoData();
  const direct = demo.conversations.find((row) => row.type === 'direct')!;
  const group = demo.conversations.find((row) => row.type === 'group')!;
  const binding = { expectedAccountUin: '90001', expectedAccountConfigId: 'draft-fixture' };
  let input: Input = {
    binding,
    messageScope: JSON.stringify(Object.values(binding)),
    openedUin: binding.expectedAccountUin,
    activeConversationId: direct.id,
    resolveConversation: (id) => [direct, group].find((row) => row.id === id),
  };
  let current!: ReturnType<typeof useWorkspaceDrafts>;
  let renders = 0;
  function Probe() {
    renders++;
    current = useWorkspaceDrafts(input);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = async (next: Partial<Input> = {}) => {
    input = { ...input, ...next };
    const node: ReactNode = createElement(Probe);
    await act(async () => root.render(strict ? createElement(StrictMode, null, node) : node));
  };
  cleanups.push(async () => act(async () => root.unmount()));
  await render();
  return {
    direct,
    group,
    render,
    get current() {
      return current;
    },
    get input() {
      return input;
    },
    get renders() {
      return renders;
    },
    edit: async (id: string, text: string) => act(async () => current.updateDraft(id, text)),
    flush: async () => act(async () => current.flushAllDirtyDrafts()),
  };
}

it('逐字输入只保存恢复快照，无关重绘不保存、不重建事件回调', async () => {
  const c = await fixture();
  const renders = c.renders;
  const update = c.current.updateDraft;
  await c.edit(c.direct.id, 'a');
  await c.edit(c.direct.id, 'ab');
  expect(c.renders).toBe(renders);
  expect(composerDraftRecovery.load(c.input.messageScope)[c.direct.id]).toBe('ab');
  await c.render({ resolveConversation: (id) => (id === c.direct.id ? c.direct : undefined) });
  expect(c.current.updateDraft).toBe(update);
  expect(f.save).not.toHaveBeenCalled();
});

it('迟到的远端草稿不能覆盖本机输入，清空记录也优先于远端旧正文', async () => {
  const c = await fixture();
  await c.edit(c.direct.id, '本机新稿');
  await c.edit(c.group.id, '');
  f.rows = [c.direct, c.group].map((row) => ({
    targetUid: row.id,
    version: 'remote',
    elements: [{ kind: 'text', textContent: '远端旧稿' }],
  }));
  await c.render();
  expect(c.current.drafts[c.direct.id]).toBe('本机新稿');
  expect(c.current.drafts[c.group.id]).toBeUndefined();
  await c.flush();
  expect(f.save.mock.calls.find(([input]) => input.kind === 'group')?.[0].elements).toEqual([]);
});

it('清空立即更新回填正文，离开页面时无需等待清空回执', async () => {
  const c = await fixture();
  const id = c.direct.id;
  f.rows = [
    { targetUid: id, version: 'old', elements: [{ kind: 'text', textContent: '已发送的原稿' }] },
  ];
  await c.render();
  expect(c.current.drafts[id]).toBe('已发送的原稿');
  let finish!: (value: unknown) => void;
  f.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await c.edit(id, '');
  await c.flush();
  expect(f.save.mock.calls[0][0].elements).toEqual([]);
  expect(c.current.drafts[id]).toBeUndefined();
  expect(composerDraftRecovery.load(c.input.messageScope)[id]).toBe('');
  await act(async () => finish({ ok: true, current: { version: 'cleared', value: null } }));
  expect(composerDraftRecovery.load(c.input.messageScope)[id]).toBeUndefined();
});

it('本端清空后马上输入，切页时能回填新稿，遇到另一端清空也能保存', async () => {
  const c = await fixture();
  const id = c.direct.id;
  f.rows = [{ targetUid: id, version: 'old', elements: [{ kind: 'text', textContent: '原稿' }] }];
  await c.render();
  await c.edit(id, '');
  await c.edit(id, '新输入');

  let finish!: (value: unknown) => void;
  f.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await c.flush();
  expect(c.current.drafts[id]).toBe('新输入');
  await act(async () => finish({ ok: false, current: { version: 'cleared', value: null } }));
  expect(f.save.mock.calls.map(([input]) => input.expectedVersion)).toEqual([null, 'cleared']);
  expect(c.current.drafts[id]).toBe('新输入');
});

it('图片准备比清空晚完成时，过期正文不能再写入 QQ 草稿', async () => {
  const c = await fixture();
  const id = c.direct.id;
  let finish!: () => void;
  f.share.mockImplementationOnce(
    (_account, _conversation, body) =>
      new Promise((resolve) => {
        finish = () => resolve(body);
      }),
  );
  await c.edit(id, '包含待上传图片的旧稿');
  await c.flush();
  expect(f.save).not.toHaveBeenCalled();
  await c.edit(id, '');
  await c.flush();
  await act(async () => finish());
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.save.mock.calls[0][0].elements).toEqual([]);
  expect(c.current.drafts[id]).toBeUndefined();
});

it('旧稿写入遇到冲突时，排队中的清空使它停止重试', async () => {
  const c = await fixture();
  const id = c.direct.id;
  let finish!: (value: unknown) => void;
  f.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await c.edit(id, '旧稿');
  await c.flush();
  expect(f.save).toHaveBeenCalledOnce();
  await c.edit(id, '');
  await c.flush();
  await act(async () =>
    finish({
      ok: false,
      current: { version: 'other', value: [{ kind: 'text', textContent: '另一端' }] },
    }),
  );
  expect(f.save.mock.calls.map(([input]) => input.elements)).toEqual([
    [{ kind: 'text', textContent: '旧稿' }],
    [],
  ]);
  expect(f.retry).not.toHaveBeenCalled();
  expect(c.current.drafts[id]).toBeUndefined();
});

it.each(['', '另一端的新稿'])('侧栏切回时使用已保存草稿的刷新结果 %j', async (remote) => {
  const c = await fixture();
  const id = c.direct.id;
  await c.edit(id, '本端曾保存的旧稿');
  await c.render({ activeConversationId: c.group.id });
  expect(c.current.drafts[id]).toBe('本端曾保存的旧稿');
  f.rows = remote
    ? [{ targetUid: id, version: 'remote', elements: [{ kind: 'text', textContent: remote }] }]
    : [];
  await c.render();
  await act(async () => c.current.syncDraftsFromPending());
  await c.render({ activeConversationId: id });
  expect(c.current.drafts[id]).toBe(remote || undefined);
});

it('重启后按快照的编辑基准识别另一端清空，清空后新输入仍可保存', async () => {
  const original = await fixture();
  const id = original.direct.id;
  const elements = [{ kind: 'text', textContent: '旧稿' }];
  f.rows = [{ targetUid: id, version: 'old', elements }];
  await original.render();
  await original.edit(id, '旧稿');

  f.rows = [];
  const reloaded = await fixture();
  expect(reloaded.current.drafts[id]).toBe('旧稿');
  const cleared = { version: 'cleared', value: null };
  f.save.mockResolvedValueOnce({ ok: false, current: cleared });
  await reloaded.flush();
  expect(f.save).toHaveBeenCalledOnce();
  expect(f.save.mock.calls[0][0].expectedVersion).toBe('old');
  expect(reloaded.current.drafts[id]).toBeUndefined();
  expect(composerDraftRecovery.load(reloaded.input.messageScope)[id]).toBeUndefined();
  // 空会话列表随后刷新也不妨碍输入下一稿。
  f.rows = [];
  await reloaded.render();
  f.save.mockResolvedValueOnce({ ok: false, current: cleared });
  await reloaded.edit(id, '清空后的新稿');
  await reloaded.flush();
  expect(f.save.mock.calls.slice(1).map(([input]) => input.expectedVersion)).toEqual([
    null,
    'cleared',
  ]);
  expect(reloaded.current.drafts[id]).toBe('清空后的新稿');
});

it.each(['direct', 'group'] as const)(
  '离开 %s 会话统一保存，目录外的已解析目标也可写回',
  async (kind) => {
    const c = await fixture();
    const row = c[kind];
    await c.render({ activeConversationId: row.id });
    await c.edit(row.id, '离开前的正文');
    await c.render({ activeConversationId: null });
    expect(f.share).toHaveBeenCalledWith(
      c.input.messageScope,
      row.id,
      '离开前的正文',
      expect.any(Function),
      undefined,
      c.input.openedUin,
    );
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.save.mock.calls[0][0]).toMatchObject({
      ...c.input.binding,
      kind: kind === 'group' ? 'group' : 'c2c',
      targetUid: row.type === 'group' ? row.group.identityValue : row.otherUser?.id,
    });
    expect(composerDraftRecovery.load(c.input.messageScope)[row.id]).toBeUndefined();
  },
);

it('保存期间继续输入，旧回执不清掉新草稿或它的恢复快照', async () => {
  const c = await fixture();
  let finish!: (value: unknown) => void;
  f.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await c.edit(c.direct.id, '第一稿');
  await c.flush();
  await c.edit(c.direct.id, '继续写的新稿');
  await act(async () => finish({ ok: true, current: { version: 'old', value: [] } }));
  expect(composerDraftRecovery.load(c.input.messageScope)[c.direct.id]).toBe('继续写的新稿');
  await act(async () => c.current.syncDraftsFromPending());
  expect(c.current.drafts[c.direct.id]).toBe('继续写的新稿');
  await c.flush();
  expect(f.save).toHaveBeenCalledTimes(2);
});

it('语音回执到达时以最新已保存的正文为准，保留已经落库的新稿', async () => {
  const c = await fixture();
  const id = c.direct.id;
  await c.edit(id, '用于合成的文字');
  await c.flush();
  const onAccepted = c.current.clearSentSpeechDraft;
  await c.edit(id, '稍后写的新稿');
  await c.flush();
  await act(async () => onAccepted(id, '用于合成的文字'));
  expect(c.current.drafts[id]).toBe('稍后写的新稿');
  expect(f.save).toHaveBeenCalledTimes(2);
});

it('保存失败保留恢复快照与可重试动作', async () => {
  const c = await fixture();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    f.save.mockRejectedValueOnce(new Error('fixture save failed'));
    await c.edit(c.direct.id, '不能丢的内容');
    await c.flush();
    expect(composerDraftRecovery.load(c.input.messageScope)[c.direct.id]).toBe('不能丢的内容');
    expect(f.retry).toHaveBeenCalledOnce();
    await act(async () => f.retry.mock.calls[0][1]());
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(composerDraftRecovery.load(c.input.messageScope)[c.direct.id]).toBeUndefined();
  } finally {
    log.mockRestore();
  }
});

it.each([false, true])(
  '切换数据源后旧保存回执不修改新源正文、版本或恢复快照，切回原源=%s',
  async (returnToOriginal) => {
    const c = await fixture();
    let finish!: (value: unknown) => void;
    f.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await c.edit(c.direct.id, '相同正文');
    await c.flush();
    const originalBinding = c.input.binding!;
    const otherBinding = { ...originalBinding, expectedAccountConfigId: 'other-source' };
    const binding = returnToOriginal ? originalBinding : otherBinding;
    const messageScope = JSON.stringify(Object.values(binding));
    composerDraftRecovery.write(messageScope, c.direct.id, '相同正文');
    await c.render({
      binding: otherBinding,
      messageScope: JSON.stringify(Object.values(otherBinding)),
    });
    await c.render({ binding, messageScope });
    await act(async () => finish({ ok: true, current: { version: 'old-source', value: [] } }));
    expect(composerDraftRecovery.load(messageScope)[c.direct.id]).toBe('相同正文');
    await c.flush();
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.save.mock.calls[1][0]).toMatchObject({ ...binding, expectedVersion: null });
  },
);

it('StrictMode 挂载清理重放后仍能保存', async () => {
  const c = await fixture(true);
  await c.edit(c.direct.id, '严格模式正文');
  await c.flush();
  expect(f.save).toHaveBeenCalledOnce();
});
