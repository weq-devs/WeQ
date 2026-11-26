import type { Message } from '../im-template/template/types';
import type { MfTarget } from './mergeForward/model';
import {
  forwardMessageContent,
  forwardSequentially,
  validateForwardOptions,
  estimateForwardDuration,
  formatForwardDuration,
  forwardMessageBlockReason,
  type ForwardOptions,
} from '../lib/sequentialForward';
import { useToast } from './Toast.shared';
import { notificationSource } from '../lib/notificationNavigation.shared';
import {
  localBackgroundTasks,
  rememberWindowTask,
  recordForwardTask,
} from '../state/backgroundTasks';
import { singleChatFile } from '../lib/chatFileForward';
import type { BackgroundTaskScope } from '../../../shared/background_task';

/** 各目标独立并行，目标内等待逐条回执；生命周期独立于已关闭的配置弹窗。 */
export function startSequentialForward({
  messages,
  targets,
  options,
  onSend,
  onOpenTarget,
  scope,
}: {
  messages: readonly Message[];
  targets: readonly MfTarget[];
  options: ForwardOptions;
  onSend: (message: Message, target: MfTarget, signal: AbortSignal) => Promise<void>;
  onOpenTarget: (target: MfTarget) => void;
  scope: BackgroundTaskScope;
}): { controller: AbortController; done: Promise<void> } {
  validateForwardOptions(options);
  if (messages.some((message) => forwardMessageBlockReason(message)))
    throw new Error('所选消息已变化，请重新选择并转发');
  if (!messages.length || !targets.length) throw new Error('没有可发送的消息或目标');
  const controller = new AbortController();
  const toast = useToast.getState();
  const wait = estimateForwardDuration(messages.map(forwardMessageContent), options, 1);
  const configuredWaitMs = (wait.minMs + wait.maxMs) / 2;
  const run = async (target: MfTarget) => {
    const local = new AbortController();
    const abort = () => local.abort();
    controller.signal.addEventListener('abort', abort, { once: true });
    if (controller.signal.aborted) local.abort();
    let sent = 0;
    let failed = 0;
    let sendSpentMs = 0;
    let lastError = '';
    const failures: string[] = [];
    const receipts = new Map<number, string>();
    const receiptDetails = () => [
      ...[...receipts].map(([index, state]) => `第 ${index + 1} 条：${state}`),
      ...(receipts.size < messages.length
        ? [`尚未开始：${messages.length - receipts.size} 条`]
        : []),
    ];
    let label = '正在转发';
    const startedAt = Date.now();
    const taskId = localBackgroundTasks.start({
      kind: 'forward',
      name: target.name,
      scope,
      display: { action: '逐条转发消息', subject: target.name },
    });
    const taskSource = notificationSource(
      { kind: 'task', id: `background:window:${taskId}` },
      '查看任务',
      scope.configId
        ? { expectedAccountUin: scope.uin, expectedAccountConfigId: scope.configId }
        : null,
    );
    const openAction = { id: 'open', label: '打开对话', run: () => onOpenTarget(target) };
    localBackgroundTasks.setActions(taskId, [
      {
        id: 'stop',
        label: '停止向此会话发送',
        run: () => {
          local.abort();
          label = '停止收尾中';
          localBackgroundTasks.update(taskId, { statusLabel: label });
        },
      },
      openAction,
    ]);
    const update = (finished = false) => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      const completed = sent + failed;
      const expected =
        configuredWaitMs + (completed ? (sendSpentMs / completed) * messages.length : 0);
      const time = formatForwardDuration(Math.floor(elapsed / 1000) * 1000);
      const estimate = expected ? formatForwardDuration(Math.ceil(expected / 1000) * 1000) : '待估';
      const counts = `已处理 ${completed} / ${messages.length} 条 · 成功 ${sent} · 失败 ${failed}`;
      localBackgroundTasks.update(taskId, {
        progress: (completed / messages.length) * 100,
        statusLabel: label,
        note: `${counts} · 已进行 ${time}${finished ? '' : ` / 预计用时 ${estimate}`}`,
        details: receiptDetails(),
      });
      return counts;
    };
    update();
    rememberWindowTask(taskId);
    const clock = setInterval(() => update(), 1000);
    let stopped: string | null = null;
    try {
      await forwardSequentially(messages, options, {
        signal: local.signal,
        shouldRetry: (message) => !singleChatFile(message),
        text: (message) => forwardMessageContent(message).text,
        nonText: (message) => forwardMessageContent(message).nonText,
        time: (message) => forwardMessageContent(message).timestampMs,
        send: async (message) => {
          const start = Date.now();
          try {
            await onSend(message, target, local.signal);
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            throw error;
          } finally {
            sendSpentMs += Math.max(0, Date.now() - start);
          }
        },
        progress: (index, attempt, state) => {
          receipts.set(
            index,
            state === 'sent'
              ? '已发送'
              : state === 'failed'
                ? '发送失败或结果未确认'
                : '已开始发送，结果待核对',
          );
          if (state === 'sent') sent++;
          if (state === 'failed') {
            failed++;
            if (failures.length < 5) failures.push(`第 ${index + 1} 条：${lastError}`);
          }
          label =
            state === 'sending'
              ? `正在发送${attempt > 1 ? ` · 第 ${attempt} 次尝试` : ''}`
              : state === 'sent'
                ? '等待继续'
                : '发送失败';
          update();
          rememberWindowTask(taskId);
        },
      });
      local.signal.throwIfAborted();
    } catch (error) {
      stopped = local.signal.aborted
        ? '已停止后续转发'
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      clearInterval(clock);
      controller.signal.removeEventListener('abort', abort);
    }
    const cancelled = local.signal.aborted;
    const partial = failed > 0 && sent > 0;
    label = cancelled
      ? '转发已停止'
      : partial
        ? '部分完成'
        : stopped || failed
          ? '转发失败'
          : '转发完成';
    const counts = update(true);
    localBackgroundTasks.finish(
      taskId,
      local.signal.aborted ? 'cancelled' : stopped || failed ? 'failed' : 'completed',
      {
        statusLabel: label,
        forwardTargets: [target],
        details: [stopped, ...receiptDetails(), ...failures].filter((line): line is string =>
          Boolean(line),
        ),
      },
    );
    localBackgroundTasks.setActions(taskId, [openAction]);
    rememberWindowTask(taskId);
    void recordForwardTask(taskId);
    const problem = failed > 0 || Boolean(stopped && !cancelled);
    if (problem || partial)
      toast.push({
        taskId: `background:window:${taskId}`,
        event: 'taskFailure',
        source: taskSource,
        tone: stopped || failed ? 'warning' : 'success',
        durationKind: problem ? 'failure' : 'success',
        title: `${label}：${target.name}`,
        summary: counts,
        detail: [stopped, ...failures].filter(Boolean).join('\n') || undefined,
        ...(problem ? { ttl: 0 } : {}),
      });
  };
  const done = Promise.all(targets.map(run)).then(() => undefined);
  return { controller, done };
}
