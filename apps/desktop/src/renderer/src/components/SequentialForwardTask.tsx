import { Square } from 'lucide-react';
import type { Message } from '../im-template/template/types';
import type { MfTarget } from './mergeForward/model';
import { forwardUnsupportedReason } from '../lib/messageRepeat';
import {
  forwardMessageContent,
  forwardSequentially,
  validateForwardOptions,
  estimateForwardDuration,
  formatForwardDuration,
  type ForwardOptions,
} from '../lib/sequentialForward';
import { useToast } from './Toast';
import '../styles/sequential-forward.css';

/** 各目标独立并行，目标内等待逐条回执；生命周期独立于已关闭的配置弹窗。 */
export function startSequentialForward({
  messages,
  targets,
  options,
  onSend,
  onOpenTarget,
}: {
  messages: readonly Message[];
  targets: readonly MfTarget[];
  options: ForwardOptions;
  onSend: (message: Message, target: MfTarget, signal: AbortSignal) => Promise<void>;
  onOpenTarget: (target: MfTarget) => void;
}): { controller: AbortController; done: Promise<void> } {
  validateForwardOptions(options);
  if (messages.some((message) => forwardUnsupportedReason(message.qqElements ?? [])))
    throw new Error('请先确认跳过不可等价重发的消息');
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
    let label = '正在转发';
    let finished = false;
    const startedAt = Date.now();
    const progress = () => {
      const elapsed = Math.max(0, Date.now() - startedAt);
      const completed = sent + failed;
      const expected = finished
        ? elapsed
        : configuredWaitMs + (completed ? (sendSpentMs / completed) * messages.length : 0);
      return (
        <span className="weq-forward-banner" data-forward-target={target.id}>
          <span className="weq-forward-banner-label">
            {label} · {target.name}
          </span>
          <span className="weq-forward-banner-progress">
            <progress
              max={Math.max(1, expected)}
              value={
                finished
                  ? Math.max(1, expected)
                  : expected
                    ? Math.min(elapsed, expected * 0.99)
                    : undefined
              }
              aria-label="逐条转发时间进度"
            />
            <span className="weq-forward-time">
              <span>
                已进行{' '}
                {formatForwardDuration(
                  (finished ? Math.ceil(elapsed / 1000) : Math.floor(elapsed / 1000)) * 1000,
                )}
              </span>
              {' / '}
              <span>
                预计用时{' '}
                {expected || finished
                  ? formatForwardDuration(Math.ceil(expected / 1000) * 1000)
                  : '待估'}
              </span>
            </span>
            <span className="weq-forward-count">
              已处理 {completed} / {messages.length} 条 · 成功 {sent} · 失败 {failed}
            </span>
            {!finished ? (
              <button
                type="button"
                title="停止向此会话发送"
                aria-label="停止向此会话发送"
                onClick={() => local.abort()}
              >
                <Square size={14} />
              </button>
            ) : null}
          </span>
        </span>
      );
    };
    const id = toast.push({
      title: progress(),
      ttl: 0,
      dismissible: false,
      action: { label: `打开对话：${target.name}`, run: () => onOpenTarget(target) },
    });
    const update = () => toast.update(id, { title: progress() });
    const clock = setInterval(update, 1000);
    let stopped: string | null = null;
    try {
      await forwardSequentially(messages, options, {
        signal: local.signal,
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
    finished = true;
    label = stopped ? '转发已停止' : '转发完成';
    toast.update(id, {
      tone: stopped || failed ? 'warning' : 'success',
      title: progress(),
      detail: [stopped, ...failures].filter(Boolean).join('\n') || undefined,
      ttl: 0,
      dismissible: true,
    });
  };
  const done = Promise.all(targets.map(run)).then(() => undefined);
  return { controller, done };
}
