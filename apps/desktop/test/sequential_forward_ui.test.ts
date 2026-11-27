import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SequentialForwardDialog } from '../src/renderer/src/components/SequentialForwardDialog';
import { MessageBatchActionDialog } from '../src/renderer/src/components/MessageBatchActionDialog';
import { reviewMessageBatch } from '../src/renderer/src/lib/messageBatchAction';
import { startSequentialForward } from '../src/renderer/src/components/SequentialForwardTask';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { DEFAULT_FORWARD_OPTIONS } from '../src/renderer/src/lib/sequentialForward';
import {
  readForwardPlan,
  writeForwardPlan,
  type MergeForwardPlan,
  type SequentialForwardPlan,
} from '../src/renderer/src/lib/forwardContinuation';
import {
  resolveForwardReplyPrefix,
  sequentialReplyTargets,
} from '../src/renderer/src/lib/sequentialForwardReply';
import {
  ForwardedConversationsDialog,
  MergeForwardTargets,
} from '../src/renderer/src/components/mergeForward/MergeForwardTargets';
import { MergeForwardDialog } from '../src/renderer/src/components/mergeForward/MergeForwardDialog';
import { runMergeForwardTask } from '../src/renderer/src/components/mergeForward/mergeForwardTask';
import { createEmptyDraft, createNode } from '../src/renderer/src/components/mergeForward/model';
import { bindAccountState } from '../src/renderer/src/lib/clientPreferences';
import { backgroundTaskNavigation } from '../src/renderer/src/components/tasks/backgroundTaskNavigation';
import { onNotificationNavigation } from '../src/renderer/src/lib/notificationNavigation.shared';
import { createTemplateDemoData } from './support/templateDemoData';
import { localBackgroundTasks } from '../src/renderer/src/state/backgroundTasks';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data: path.includes('getAccountConfig')
                ? { uin: '', configId: 'fixture' }
                : undefined,
              isLoading: false,
            })
          : proxy([...path, String(key)]),
    });
  return {
    trpc: proxy(),
    client: proxy(),
  };
});

afterEach(() => {
  for (const task of localBackgroundTasks.snapshot()) {
    localBackgroundTasks.finish(task.id, 'cancelled');
    localBackgroundTasks.remove(task.id);
  }
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const target = {
  id: 'qa-group',
  kind: 'group' as const,
  conv: '777',
  name: '合成目标群',
  avatarUrl: null,
};
const demo = createTemplateDemoData();
const messages = [
  {
    ...demo.messages[0]!,
    id: 'text',
    body: '甲乙',
    qqElements: [{ type: 'text', data: { textContent: '甲乙' } }],
  },
  {
    ...demo.messages[0]!,
    id: 'media',
    body: '这部分文本不参与计时',
    qqElements: [
      { type: 'text', data: { textContent: '这部分文本不参与计时' } },
      { type: 'pic', data: {} },
    ],
  },
];

const quotedMessage = { ...messages[0]!, msgSeq: '70', clientSeq: '9' };
const replyElement = {
  type: 'reply',
  data: {
    origMsgSeq: 70,
    origElements: [{ type: 'text', data: { textContent: '原文' } }],
  },
};
const replyMessage = {
  ...messages[0]!,
  id: 'reply',
  qqElements: [replyElement, ...messages[0]!.qqElements],
};

it('中断后只发送未提交项，保留原目标引用及结果未知的条目', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  const scope = { uin: 'fixture', configId: 'original' };
  const id = localBackgroundTasks.start({ kind: 'forward', name: target.name, scope });
  localBackgroundTasks.finish(id, 'paused');
  const plan: SequentialForwardPlan = {
    version: 1,
    kind: 'sequential',
    scope,
    target,
    messages: [quotedMessage, { ...messages[0]!, id: 'unknown' }, replyMessage],
    entries: [
      { state: 'sent', receipt: { groupSequence: 151 } },
      { state: 'submitting' },
      { state: 'pending' },
    ],
    options: { ...DEFAULT_FORWARD_OPTIONS, maxAttempts: 3 },
    sourceKind: 'group',
    includeExcerpt: true,
  };
  writeForwardPlan(id, plan);
  expect(readForwardPlan(id, { ...scope, configId: 'other' })).toBeUndefined();
  const onSend = vi.fn(async (_message, _target, _signal, receipt) => {
    expect(receipt).toEqual({ groupSequence: 151 });
    expect(readForwardPlan(id, scope)?.entries[2]?.state).toBe('submitting');
    throw new Error('合成的未知回执');
  });
  await startSequentialForward({
    ...plan,
    targets: [target],
    onSend,
    onOpenTarget: vi.fn(),
    resume: { id, plan },
  }).done;
  expect(onSend.mock.calls.map(([message]) => message.id)).toEqual([replyMessage.id]);
  expect(localBackgroundTasks.snapshot().find((task) => task.id === id)).toMatchObject({
    needsConfirmation: true,
    details: expect.arrayContaining(['第 2 条：结果待核对，继续时已跳过']),
  });
  expect(readForwardPlan(id, scope)).toBeUndefined();
});

it('合并转发恢复时只向尚未提交的会话发送，保留其他会话的结果', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
  const scope = { uin: 'fixture', configId: 'original' };
  const id = localBackgroundTasks.start({ kind: 'forward', name: target.name, scope });
  localBackgroundTasks.finish(id, 'paused');
  const unknown = { ...target, id: 'unknown', conv: '222', name: '待核对' };
  const remaining = { ...target, id: 'remaining', conv: '333', name: '未提交' };
  const plan: MergeForwardPlan = {
    version: 1,
    kind: 'merged',
    scope,
    draft: createEmptyDraft(),
    targets: [target, unknown, remaining],
    entries: [{ state: 'sent', targetSeq: '70' }, { state: 'submitting' }, { state: 'pending' }],
  };
  writeForwardPlan(id, plan);
  const send = vi.fn(async () => ({ seq: '71' }));
  const result = await runMergeForwardTask({
    draft: plan.draft,
    targets: plan.targets,
    binding: { expectedAccountUin: scope.uin, expectedAccountConfigId: scope.configId },
    send,
    isCurrent: () => true,
    resume: { id, plan },
  });
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(plan.draft, remaining, expect.any(Object), true);
  expect(result.unconfirmed).toEqual([unknown]);
  expect(result.sent).toEqual([
    { ...target, seq: '70' },
    { ...remaining, seq: '71' },
  ]);
  expect(readForwardPlan(id, scope)).toBeUndefined();
});

it('分别把每个目标的发送回执用于同批引用，前一条失败时没有新引用目标', async () => {
  const second = { ...target, id: 'second', conv: '888' };
  const failed = { ...target, id: 'failed', conv: '999' };
  const seen = new Map<string, number | undefined>();
  const task = startSequentialForward({
    messages: [quotedMessage, replyMessage],
    targets: [target, second, failed],
    scope: { uin: 'fixture', configId: 'fixture-config' },
    sourceKind: 'group',
    options: DEFAULT_FORWARD_OPTIONS,
    onOpenTarget: vi.fn(),
    onSend: async (message, destination, _signal, receipt) => {
      if (message.id === replyMessage.id) {
        seen.set(destination.id, receipt?.groupSequence);
        return;
      }
      if (destination.id === failed.id) throw new Error('发送失败');
      return { groupSequence: destination.id === target.id ? 101 : 202 };
    },
  });
  await task.done;
  expect(seen).toEqual(
    new Map([
      [target.id, 101],
      [second.id, 202],
      [failed.id, undefined],
    ]),
  );
});

it('私聊引用按发送方序号和身份匹配，避免同序号的其他人或其他会话', () => {
  const original = { ...quotedMessage, senderUid: 'sender-a', sendTime: '100' };
  const wrongSender = { ...original, id: 'other', senderUid: 'sender-b' };
  const wrongChat = { ...original, id: 'other-chat', conversationId: 'other-chat' };
  const older = { ...original, id: 'older', sendTime: '90' };
  const reply = {
    ...replyMessage,
    qqElements: [
      { type: 'reply', data: { origMsgSeq: 9, origSenderUid: 'sender-a', origMsgTime: 100 } },
    ],
  };
  expect(sequentialReplyTargets([original, wrongSender, wrongChat, older, reply], 'c2c')).toEqual(
    new Map([[reply.id, original.id]]),
  );
  expect(sequentialReplyTargets([wrongSender, wrongChat, older, reply], 'c2c').size).toBe(0);
});

it('优先引用本批发送，再查原消息，无法定位时仅按开关附摘录', async () => {
  const original = vi.fn(async () => ({ sequence: 9, index: 70 }));
  const options = {
    data: replyElement.data,
    kind: 'c2c' as const,
    uin: '123',
    includeExcerpt: true,
  };
  const forwarded = await resolveForwardReplyPrefix({
    ...options,
    receipt: { privateSequence: 300, clientSequence: 21, timestamp: 100 },
    original,
  });
  expect(forwarded?.element).toMatchObject({ kind: 'reply', origMsgSeq: 21, origSenderUin: 123 });
  expect(forwarded?.preview.data?.origMsgIndex).toBe(300);
  expect(original).not.toHaveBeenCalled();
  const existing = await resolveForwardReplyPrefix({
    ...options,
    receipt: { privateSequence: 300 },
    original,
  });
  expect(existing?.element).toMatchObject({ kind: 'reply', origMsgSeq: 9 });
  expect(original).toHaveBeenCalledOnce();
  expect((await resolveForwardReplyPrefix(options))?.element).toEqual({
    kind: 'text',
    textContent: '> 原文\n',
  });
  expect(await resolveForwardReplyPrefix({ ...options, includeExcerpt: false })).toBeUndefined();
});

it('引用摘录默认关闭，打开后随本次确认提交', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onContinue = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(MessageBatchActionDialog, {
          action: 'forward',
          batch: reviewMessageBatch([quotedMessage, replyMessage], 'forward'),
          user: demo.user,
          onContinue,
          onClose: vi.fn(),
        }),
      ),
    );
    const [include, excerpt] = document.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    const proceed = document.querySelector<HTMLButtonElement>('[data-weq-dialog-confirm]')!;
    act(() => proceed.click());
    expect(onContinue).toHaveBeenLastCalledWith([quotedMessage, replyMessage], false);
    act(() => excerpt!.click());
    act(() => proceed.click());
    expect(onContinue).toHaveBeenLastCalledWith([quotedMessage, replyMessage], true);
    act(() => include!.click());
    expect(excerpt!.disabled).toBe(true);
    act(() => proceed.click());
    expect(onContinue).toHaveBeenLastCalledWith([quotedMessage], false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('多个目标并行发送且群内保序，一个目标失败不会阻塞其他目标', async () => {
  const second = { ...target, id: 'second', conv: '888', name: '第二目标群' };
  let release: (() => void) | undefined;
  const events: string[] = [];
  const task = startSequentialForward({
    scope: { uin: 'fixture', configId: 'fixture-config' },
    messages,
    targets: [target, second],
    options: DEFAULT_FORWARD_OPTIONS,
    onSend: async (message, destination) => {
      events.push(`${destination.id}:${message.id}`);
      if (destination.id === target.id && message.id === 'text')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (destination.id === second.id && message.id === 'text') throw new Error('第二群拒绝');
    },
    onOpenTarget: vi.fn(),
  });
  try {
    await vi.waitFor(() => expect(events).toContain('second:media'));
    expect(events).toContain('second:text');
    expect(events).not.toContain('qa-group:media');
    expect(useToast.getState().toasts.map((toast) => toast.event)).toEqual(['taskFailure']);
    expect(
      localBackgroundTasks.snapshot().find((entry) => entry.name === target.name)?.status,
    ).toBe('running');
  } finally {
    release?.();
    await task.done;
  }
  expect(events).toEqual(['qa-group:text', 'second:text', 'second:media', 'qa-group:media']);
  expect(useToast.getState().toasts.map((toast) => toast.tone)).toEqual(['warning']);
  const failed = localBackgroundTasks.snapshot().find((entry) => entry.name === second.name)!;
  expect(useToast.getState().toasts[0]!.source?.target).toEqual({
    kind: 'task',
    id: `background:window:${failed.id}`,
  });
});

it('先在分组弹窗筛掉系统提示，可取消并展开预览，再只把确认的消息交给转发', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async (_message: unknown) => {});
  const ignored = {
    ...messages[0]!,
    id: 'poke',
    body: '甲戳了戳乙',
    qqElements: [
      {
        type: 'grayTipPoke',
        data: { tipJson: JSON.stringify({ items: [{ type: 'nor', txt: '甲戳了戳乙' }] }) },
      },
    ],
  };
  const failed = { ...messages[0]!, id: 'failed', optimistic: 'failed' as const };
  const batch = reviewMessageBatch([messages[0]!, ignored, failed], 'forward');
  function Review() {
    const [stage, setStage] = useState<
      import('../src/renderer/src/im-template/template/types').Message[] | null
    >();
    if (stage === null) return null;
    return stage
      ? createElement(SequentialForwardDialog, {
          messages: stage,
          targets: [target],
          onSend: send,
          onClose: () => setStage(null),
          onOpenTarget: vi.fn(),
        })
      : createElement(MessageBatchActionDialog, {
          action: 'forward',
          batch,
          user: { ...demo.user, identityValue: '' },
          onContinue: setStage,
          onClose: () => setStage(null),
        });
  }
  const confirm = () => document.querySelector<HTMLButtonElement>('[data-weq-dialog-confirm]')!;
  try {
    act(() => root.render(createElement(Review)));
    expect(document.querySelector('.weq-mf-target')).toBeNull();
    const [tip] = document.querySelectorAll('details');
    act(() => {
      tip!.open = true;
      tip!.dispatchEvent(new Event('toggle'));
    });
    expect(document.querySelector('[aria-label="系统提示"]')?.textContent).toContain('甲戳了戳乙');
    expect(
      document.querySelector('[aria-label="系统提示"] .weq-system-message-row'),
    ).not.toBeNull();
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    act(() => toggle.click());
    expect(confirm().textContent).toContain('1 条');
    expect(send).not.toHaveBeenCalled();
    act(() => confirm().click());
    expect(document.querySelector('.weq-message-batch-dialog')).toBeNull();
    expect(document.querySelector('.weq-mf-target')).not.toBeNull();
    expect(document.querySelector('.weq-sequential-forward')?.textContent).not.toContain(
      '无法转发',
    );
    act(() => document.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
    await act(async () => confirm().click());
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toEqual(messages[0]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('未选目标就显示时分秒预估，多个并行目标不增加预估，默认不限间隔且失败继续', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(SequentialForwardDialog, {
          messages: [
            { ...messages[0]!, createdAt: '2026-10-21T01:00:00Z' },
            { ...messages[0]!, id: 'later', createdAt: '2026-10-21T02:01:01Z' },
          ],
          targets: [target, { ...target, id: 'second', conv: '888', name: '第二群' }],
          onSend: vi.fn(),
          onClose: vi.fn(),
          onOpenTarget: vi.fn(),
        }),
      ),
    );
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain('预计用时 0 秒');
    act(() =>
      document.querySelectorAll<HTMLButtonElement>('[aria-label="间隔方式"] button')[2]!.click(),
    );
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain(
      '1 小时 1 分钟 1 秒',
    );
    const labels = [...document.querySelectorAll('label')];
    expect(
      labels.find((label) => label.textContent?.includes('最大间隔'))?.querySelector('input')
        ?.value,
    ).toBe('-1');
    expect(document.querySelector('[aria-label="失败后"] [aria-checked="true"]')?.textContent).toBe(
      '忽略并继续',
    );
    expect(document.querySelector('.weq-forward-options')?.textContent).not.toContain('毫秒');
    act(() =>
      document.querySelectorAll<HTMLButtonElement>('.weq-mf-target').forEach((button) => {
        button.click();
      }),
    );
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain(
      '1 小时 1 分钟 1 秒',
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('全是无法转发的消息时只显示可展开的说明和关闭动作', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const proceed = vi.fn();
  const close = vi.fn();
  try {
    act(() =>
      root.render(
        createElement(MessageBatchActionDialog, {
          action: 'forward',
          batch: reviewMessageBatch(
            [{ ...messages[0]!, qqElements: [{ type: 'call', data: {} }] }],
            'forward',
          ),
          user: demo.user,
          onContinue: proceed,
          onClose: close,
        }),
      ),
    );
    expect(document.querySelector('.weq-mf-target')).toBeNull();
    expect(document.querySelector('summary')?.textContent).toContain('无法转发');
    const actions = document.querySelectorAll<HTMLButtonElement>(
      '.weq-message-batch-dialog footer button',
    );
    expect(actions).toHaveLength(1);
    act(() => actions[0]!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(proceed).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('只停止一个目标，不跳转也不停止其他群；所有队列结束清理计时器', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const second = { ...target, id: 'second', conv: '888', name: '第二群' };
  const send = vi.fn(async (_message: unknown, _target: unknown, _signal: AbortSignal) => {});
  const open = vi.fn();
  let task: ReturnType<typeof startSequentialForward> | undefined;
  try {
    await act(async () => {
      root.render(createElement(ToastHost));
      task = startSequentialForward({
        scope: { uin: 'fixture', configId: 'fixture-config' },
        messages,
        targets: [target, second],
        options: { ...DEFAULT_FORWARD_OPTIONS, intervalMs: 1000 },
        onSend: send,
        onOpenTarget: open,
      });
    });
    const taskFor = (name: string) =>
      localBackgroundTasks.snapshot().find((entry) => entry.name === name)!;
    expect(useToast.getState().toasts).toEqual([]);
    await act(async () => localBackgroundTasks.act(taskFor(target.name).id, 'stop'));
    expect(open).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await task!.done;
    });
    expect(send.mock.calls.map(([, destination]) => (destination as typeof target).id)).toEqual([
      'qa-group',
      'second',
      'second',
    ]);
    expect(task!.controller.signal.aborted).toBe(false);
    expect(taskFor(target.name)).toMatchObject({ status: 'cancelled', statusLabel: '转发已停止' });
    expect(taskFor(second.name)).toMatchObject({ status: 'completed', statusLabel: '转发完成' });
    await act(async () => vi.advanceTimersByTimeAsync(3500));
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    task?.controller.abort();
    await task?.done;
    act(() => root.unmount());
    host.remove();
  }
});

it('发生实际失败后再主动停止，仍保留失败时长', async () => {
  vi.useFakeTimers();
  const task = startSequentialForward({
    scope: { uin: 'fixture', configId: 'fixture-config' },
    messages,
    targets: [target],
    options: { ...DEFAULT_FORWARD_OPTIONS, intervalMs: 1000 },
    onSend: async () => {
      throw new Error('合成发送失败');
    },
    onOpenTarget: vi.fn(),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    task.controller.abort();
    await task.done;
    expect(useToast.getState().toasts.at(-1)).toMatchObject({
      tone: 'warning',
      durationKind: 'failure',
      ttl: 0,
    });
    expect(String(useToast.getState().toasts.at(-1)?.detail)).toContain('合成发送失败');
  } finally {
    task.controller.abort();
    await task.done;
  }
});

it('大量转发目标按窗口渲染，群助手保留内外已选群', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const inside = { ...target, id: 'inside', name: '助手内群', groupAssistant: true };
  const targets = [
    target,
    inside,
    ...Array.from({ length: 1_000 }, (_, i) => ({
      ...target,
      id: `group-${i}`,
      conv: String(20_000 + i),
    })),
  ];
  function View() {
    const [selected, onChange] = useState(new Set<string>());
    return createElement(
      'div',
      null,
      createElement(MergeForwardTargets, { targets, selected, onChange }),
      createElement('output', null, [...selected].join(',')),
    );
  }
  try {
    act(() => root.render(createElement(View)));
    expect(host.querySelectorAll('[data-weq-select-id]').length).toBeLessThan(50);
    expect(host.querySelectorAll('.weq-mf-target.checked')).toHaveLength(0);
    act(() =>
      host.querySelector<HTMLButtonElement>('.weq-mf-target:not(.weq-mf-assistant-entry)')!.click(),
    );
    act(() => host.querySelector<HTMLButtonElement>('.weq-mf-assistant-entry')!.click());
    act(() => host.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
    expect(host.querySelector('output')!.textContent).toBe('qa-group,inside');
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="返回全部会话"]')!.click());
    expect(host.querySelector('output')!.textContent).toBe('qa-group,inside');
    expect(host.querySelector('.weq-mf-target.checked')?.textContent).toContain('合成目标群');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it.each([1, 2])('合并转发回执可打开本次选中的 %i 个会话', async (count) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'original' };
  const self = { uid: 'u_self', uin: '10001', name: '本人' };
  const peer = { ...target, id: 'u_peer', kind: 'c2c' as const, conv: '10002', name: '好友' };
  const chosen = [peer, target].slice(0, count);
  const send = vi.fn(async () => {});
  const navigate = vi.fn();
  const unsubscribe = onNotificationNavigation(navigate);

  function View() {
    const [forwarding, setForwarding] = useState(true);
    return createElement(
      'div',
      null,
      forwarding
        ? createElement(MergeForwardDialog, {
            initialDraft: {
              ...createEmptyDraft(),
              nodes: [createNode(self, [{ t: 'text', id: 'text', text: '消息' }])],
            },
            self,
            senderMode: 'conversation',
            targets: [peer, target],
            binding,
            sendAvailable: true,
            onClose: () => setForwarding(false),
            onPersist: vi.fn(),
            onForward: send,
          })
        : null,
      createElement(ToastHost),
    );
  }

  try {
    bindAccountState(binding);
    act(() => root.render(createElement(View)));
    act(() => document.querySelector<HTMLButtonElement>('[aria-label^="下一步"]')!.click());
    for (const choice of chosen)
      act(() =>
        document
          .querySelector<HTMLButtonElement>(
            `[title="${choice.kind === 'c2c' ? `${choice.name} ${choice.conv}` : choice.name}"]`,
          )!
          .click(),
      );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[data-weq-dialog-confirm]')!.click(),
    );
    expect(send.mock.calls).toEqual(
      chosen.map((choice) => [expect.anything(), choice, binding, true]),
    );

    const record = localBackgroundTasks.snapshot().find((task) => task.kind === 'forward')!;
    expect(record).toMatchObject({ status: 'completed', forwardTargets: chosen });
    expect(useToast.getState().toasts).toEqual([]);
    const action = backgroundTaskNavigation(record)!;
    bindAccountState({ ...binding, expectedAccountConfigId: 'different' });
    await expect(async () => action.run()).rejects.toThrow('请先切回');
    expect(navigate).not.toHaveBeenCalled();
    bindAccountState(binding);
    await act(async () => {
      await action.run();
    });
    expect(navigate.mock.calls).toEqual([
      [
        {
          kind: 'forwarded-conversations',
          targets: chosen.map((target) => ({ ...target, avatarUrl: '' })),
          binding,
        },
      ],
    ]);

    if (count > 1) {
      const onOpenTarget = vi.fn();
      act(() =>
        root.render(
          createElement(ForwardedConversationsDialog, {
            targets: chosen,
            onOpenTarget,
            onClose: vi.fn(),
          }),
        ),
      );
      act(() => document.querySelector<HTMLButtonElement>('[title="合成目标群 777"]')!.click());
      expect(onOpenTarget.mock.calls).toEqual([[target]]);
    }
  } finally {
    unsubscribe();
    act(() => root.unmount());
    bindAccountState(null);
    host.remove();
  }
});

it('单条转发隐藏间隔与抖动，保留失败策略和重试设置', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(SequentialForwardDialog, {
          messages: messages.slice(0, 1),
          targets: [target],
          onSend: vi.fn(),
          onClose: vi.fn(),
          onOpenTarget: vi.fn(),
        }),
      ),
    );
    expect(document.querySelector('.weq-forward-options')?.textContent).not.toMatch(/间隔|抖动/);
    expect(document.querySelector('.weq-forward-options')?.textContent).toContain('最大尝试次数');
    expect(document.querySelector('.weq-forward-options')?.textContent).toContain('失败后');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('卸载配置窗后从任务查看持续进度、目标与完成结果', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const send = vi.fn(async (_message: unknown, _target: unknown, _signal: AbortSignal) => {});
  const open = vi.fn();
  const close = vi.fn();
  function App() {
    const [visible, setVisible] = useState(true);
    return createElement(
      'div',
      null,
      visible
        ? createElement(SequentialForwardDialog, {
            messages,
            targets: [target],
            onSend: send,
            onOpenTarget: open,
            onClose: () => {
              close();
              setVisible(false);
            },
          })
        : null,
      createElement(ToastHost),
    );
  }
  try {
    act(() => root.render(createElement(App)));
    act(() => document.querySelector<HTMLButtonElement>('.weq-mf-target')!.click());
    act(() =>
      document.querySelectorAll<HTMLButtonElement>('[aria-label="间隔方式"] button')[1]!.click(),
    );
    const labels = [...document.querySelectorAll('label')];
    expect(
      labels.find((label) => label.textContent?.includes('每字'))?.querySelector('input')?.value,
    ).toBe('1');
    expect(
      labels.find((label) => label.textContent?.includes('非文本'))?.querySelector('input')?.value,
    ).toBe('5');
    expect(document.querySelector('.weq-forward-estimate')?.textContent).toContain('7 秒');
    act(() =>
      document.querySelector<HTMLButtonElement>('.weq-sequential-forward footer button')!.click(),
    );
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('.weq-sequential-forward')).toBeNull();
    const currentTask = () =>
      localBackgroundTasks.snapshot().find((entry) => entry.name === target.name)!;
    expect(useToast.getState().toasts).toEqual([]);
    expect(currentTask().note).toContain('已进行 0 秒 / 预计用时 7 秒');
    expect(currentTask().note).toContain('0 / 2 条');
    expect(currentTask().progress).toBe(0);
    await act(async () => localBackgroundTasks.act(currentTask().id, 'open'));
    expect(open).toHaveBeenCalledWith(target);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(send).not.toHaveBeenCalled();
    expect(currentTask().progress).toBe(12.5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(currentTask().note).toContain('已进行 2 秒');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[2].aborted).toBe(false);
    expect(currentTask()).toMatchObject({
      status: 'completed',
      statusLabel: '转发完成',
      progress: 100,
    });
    expect(currentTask().note).toContain('已进行 7 秒');
    expect(currentTask().note).toContain('2 / 2 条');
    expect(currentTask().forwardTargets).toEqual([target]);
    expect(useToast.getState().toasts).toEqual([]);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('等待期间可以停止，不再发送下一条；失败保留原因且不冒称成功', async () => {
  const send = vi.fn(async () => {});
  const pending = startSequentialForward({
    scope: { uin: 'fixture', configId: 'fixture-config' },
    messages,
    targets: [target],
    options: { ...DEFAULT_FORWARD_OPTIONS, mode: 'text' },
    onSend: send,
    onOpenTarget: vi.fn(),
  });
  pending.controller.abort();
  await pending.done;
  expect(send).not.toHaveBeenCalled();
  expect(useToast.getState().toasts).toEqual([]);
  const failed = startSequentialForward({
    scope: { uin: 'fixture', configId: 'fixture-config' },
    messages,
    targets: [target],
    options: DEFAULT_FORWARD_OPTIONS,
    onSend: async () => {
      throw new Error('合成失败');
    },
    onOpenTarget: vi.fn(),
  });
  await failed.done;
  expect(useToast.getState().toasts.at(-1)?.tone).toBe('warning');
  expect(useToast.getState().toasts.at(-1)?.detail).toContain('合成失败');
  expect(useToast.getState().toasts.at(-1)).toMatchObject({
    durationKind: 'failure',
    ttl: 0,
  });
  expect(localBackgroundTasks.snapshot().map((task) => task.status)).toEqual([
    'cancelled',
    'failed',
  ]);
  expect(localBackgroundTasks.snapshot().at(-1)?.details?.join('')).toContain('合成失败');
});
