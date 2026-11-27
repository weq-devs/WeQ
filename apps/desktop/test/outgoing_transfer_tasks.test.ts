import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import {
  outgoingMediaSend,
  useOutgoingTransferTasks,
} from '../src/renderer/src/hooks/useOutgoingTransferTasks';
import { bindAccountState } from '../src/renderer/src/lib/clientPreferences';
import { onNotificationNavigation } from '../src/renderer/src/lib/notificationNavigation.shared';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';
import {
  TransferActivity,
  TransferActivityContext,
  useOutgoingTaskProgress,
} from '../src/renderer/src/lib/transferActivity';
import { summarizeWorkspaceTasks } from '../src/renderer/src/lib/workspaceIndicators';
import { localBackgroundTasks } from '../src/renderer/src/state/backgroundTasks';
import type { OptimisticMessage } from '../src/renderer/src/views/workspace/types';

it('切离会话后从任务续看同一次附件发送，确认成功后收起', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const binding = { expectedAccountUin: 'fixture', expectedAccountConfigId: 'original' };
  const scope = JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId]);
  const elements = [{ type: 'video', data: { fileName: '片段.mp4' } }];
  const sending: OptimisticMessage = {
    id: 'optimistic-fixture',
    convId: 'chat',
    body: '[视频]',
    elements,
    mediaSend: outgoingMediaSend(elements, { name: '测试群', type: 'group' }, scope),
    state: 'sending',
    transferId: 'upload',
    hostReceived: true,
    at: 1,
  };
  const host = document.createElement('div');
  const root = createRoot(host);
  const navigate = vi.fn();
  const unsubscribe = onNotificationNavigation(navigate);
  const activity = new TransferActivity();
  const policy = useNotificationPolicy.getState();
  useNotificationPolicy.setState({
    events: { ...policy.events, taskFailure: { banner: true, system: false } },
  });
  function Fixture({
    message,
    conversation,
    source,
  }: {
    message: OptimisticMessage;
    conversation?: string;
    source: typeof binding;
  }) {
    useOutgoingTransferTasks([message], source, conversation);
    return null;
  }
  function TaskProgress({ task }: { task: ReturnType<typeof currentTask> }) {
    const progress = useOutgoingTaskProgress(task);
    return h('output', null, `${progress?.label} ${progress?.percent ?? ''}`);
  }
  const currentTask = () =>
    localBackgroundTasks.snapshot().find((task) => task.kind === 'send-media')!;
  const render = (message: OptimisticMessage, conversation?: string, source = binding) =>
    act(() => root.render(h(Fixture, { message, conversation, source })));
  bindAccountState(binding);
  useToast.setState({ toasts: [], leaving: [] });
  try {
    render(sending, 'chat');
    const id = currentTask().id;
    expect(summarizeWorkspaceTasks({ background: [currentTask()] }).running).toBe(0);
    render({ ...sending, state: 'failed', error: '上传失败' }, 'chat');
    expect(currentTask().statusLabel).toBe('发送失败');
    expect(useToast.getState().toasts).toEqual([]);
    render(sending, 'other');
    expect(summarizeWorkspaceTasks({ background: [currentTask()] }).running).toBe(1);
    expect(currentTask().id).toBe(id);
    expect(currentTask().display).toMatchObject({ subject: '片段.mp4', context: '测试群' });
    const progressHost = document.createElement('div');
    const progressRoot = createRoot(progressHost);
    try {
      act(() =>
        progressRoot.render(
          h(
            TransferActivityContext.Provider,
            { value: activity },
            h(TaskProgress, { task: currentTask() }),
          ),
        ),
      );
      act(() =>
        activity.replace([
          { id: 'upload', direction: 'upload', phase: 'upload', received: 72, total: 100 },
        ]),
      );
      expect(progressHost.textContent).toBe('正在上传 72');
      act(() => activity.replace([{ id: 'upload', direction: 'upload', phase: 'confirming' }]));
      expect(progressHost.textContent).toBe('正在确认结果 ');
    } finally {
      act(() => progressRoot.unmount());
    }
    await localBackgroundTasks.act(id, 'open-message');
    expect(navigate).toHaveBeenLastCalledWith({
      kind: 'conversation',
      conversationKind: 'group',
      conv: 'chat',
      msgId: sending.id,
      dismissTaskPanel: true,
    });
    render({ ...sending, state: 'sent', seqRejected: true }, 'other');
    expect(currentTask().statusLabel).toBe('可能未送达');
    expect(useToast.getState().toasts).toHaveLength(1);
    expect(useToast.getState().toasts[0]?.source?.target).toMatchObject({ msgId: sending.id });
    render({ ...sending, state: 'sent', seqRejected: true }, 'chat');
    expect(useToast.getState().toasts).toHaveLength(1);
    render({ ...sending, state: 'sent', seqRejected: false }, 'chat');
    expect(currentTask()).toBeUndefined();
    expect(useToast.getState().toasts.some(({ event }) => event === 'taskComplete')).toBe(false);
    expect(
      outgoingMediaSend([{ type: 'text' }], { name: '测试群', type: 'group' }, scope),
    ).toBeUndefined();
    render(sending, 'other');
    expect(currentTask().status).toBe('running');
    render(sending, 'other', { ...binding, expectedAccountConfigId: 'another' });
    expect(currentTask()).toBeUndefined();
  } finally {
    act(() => root.unmount());
    unsubscribe();
    bindAccountState(null);
    useNotificationPolicy.setState(policy);
    useToast.setState({ toasts: [], leaving: [] });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
