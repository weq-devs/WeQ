import { MessageSquare, Square } from 'lucide-react';
import type { Message } from '../im-template/template/types';
import type { MfTarget } from './mergeForward/model';
import {
  forwardMessageContent,
  forwardSequentially,
  validateForwardOptions,
  estimateForwardDuration,
  formatForwardClock,
  type ForwardOptions,
} from '../lib/sequentialForward';
import { useToast } from './Toast';
import '../styles/sequential-forward.css';

/** 执行生命周期独立于配置弹窗；弹窗关闭不会撤销已经交接的发送。 */
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
  const controller = new AbortController();
  const toast = useToast.getState();
  const total = messages.length * targets.length;
  let sent = 0;
  let failed = 0;
  const startedAt = Date.now();
  const wait = estimateForwardDuration(
    messages.map(forwardMessageContent),
    options,
    targets.length,
  );
  const configuredWaitMs = (wait.minMs + wait.maxMs) / 2;
  let sendSpentMs = 0;
  let label = '逐条转发 · 等待发送';
  const delivered = new Set<string>();
  const progress = () => {
    const elapsed = Math.max(0, Date.now() - startedAt);
    const completed = sent + failed;
    const expected = configuredWaitMs + (completed ? (sendSpentMs / completed) * total : 0);
    return (
      <span className="weq-forward-banner">
        <span className="weq-forward-banner-label">{label}</span>
        <span className="weq-forward-banner-progress">
          <progress
            max={Math.max(1, expected)}
            value={expected ? Math.min(elapsed, expected * 0.99) : undefined}
            aria-label="逐条转发时间进度"
          />
          <span className="weq-forward-time">
            <span>已进行 {formatForwardClock(elapsed)}</span>
            {' / '}
            <span>
              预计用时 {expected ? formatForwardClock(Math.ceil(expected / 1000) * 1000) : '待估'}
            </span>
          </span>
          <button
            type="button"
            title="停止后续发送"
            aria-label="停止后续发送"
            onClick={() => controller.abort()}
          >
            <Square size={14} />
          </button>
        </span>
      </span>
    );
  };
  const id = toast.push({ title: progress(), ttl: 0, dismissible: false });
  const update = (next: string) => {
    label = next;
    toast.update(id, { title: progress() });
  };
  const clock = setInterval(() => toast.update(id, { title: progress() }), 1000);
  const done = (async () => {
    let stopped: string | null = null;
    try {
      for (const target of targets) {
        controller.signal.throwIfAborted();
        update(`正在转发至 ${target.name}`);
        await forwardSequentially(messages, options, {
          signal: controller.signal,
          text: (message) => forwardMessageContent(message).text,
          nonText: (message) => forwardMessageContent(message).nonText,
          time: (message) => forwardMessageContent(message).timestampMs,
          send: async (message) => {
            const start = Date.now();
            try {
              await onSend(message, target, controller.signal);
            } finally {
              sendSpentMs += Math.max(0, Date.now() - start);
            }
          },
          progress: (_index, attempt, state) => {
            if (state === 'sent') {
              sent++;
              delivered.add(target.id);
            }
            if (state === 'failed') failed++;
            update(
              `${target.name}${state === 'sending' ? ` · 正在发送${attempt > 1 ? ` · 第 ${attempt} 次尝试` : ''}` : state === 'sent' ? ' · 等待继续' : ' · 发送失败'}`,
            );
          },
        });
      }
      controller.signal.throwIfAborted();
    } catch (error) {
      stopped = controller.signal.aborted
        ? '已停止后续转发'
        : error instanceof Error
          ? error.message
          : String(error);
    } finally {
      clearInterval(clock);
    }
    toast.update(id, {
      tone: stopped || failed ? 'warning' : 'success',
      title: (
        <span className="weq-forward-banner">
          <span className="weq-forward-banner-label">
            {stopped ? '转发已停止' : '转发完成'} · 用时{' '}
            {formatForwardClock(Date.now() - startedAt)}
            {failed ? `，失败 ${failed} 条` : ''}
          </span>
          <span className="weq-forward-banner-targets">
            {targets
              .filter((target) => delivered.has(target.id))
              .map((target) => (
                <button
                  key={target.id}
                  type="button"
                  title={`打开对话：${target.name}`}
                  onClick={() => onOpenTarget(target)}
                >
                  <MessageSquare size={14} />
                  <span>{target.name}</span>
                </button>
              ))}
          </span>
        </span>
      ),
      detail: stopped,
      ttl: 0,
      dismissible: true,
    });
  })();
  return { controller, done };
}
