import { MessageSquare, Square } from 'lucide-react';
import type { Message } from '../im-template/template/types';
import type { MfTarget } from './mergeForward/model';
import {
  forwardMessageContent,
  forwardSequentially,
  validateForwardOptions,
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
  const delivered = new Set<string>();
  const progress = (label: string) => (
    <span className="weq-forward-banner">
      <span className="weq-forward-banner-label">{label}</span>
      <span className="weq-forward-banner-progress">
        <progress max={Math.max(1, total)} value={sent + failed} aria-label="逐条转发进度" />
        <span>
          {sent + failed}/{total}
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
  const id = toast.push({ title: progress('逐条转发 · 等待发送'), ttl: 0, dismissible: false });
  const done = (async () => {
    let stopped: string | null = null;
    try {
      for (const target of targets) {
        controller.signal.throwIfAborted();
        toast.update(id, { title: progress(`正在转发至 ${target.name}`) });
        await forwardSequentially(messages, options, {
          signal: controller.signal,
          text: (message) => forwardMessageContent(message).text,
          nonText: (message) => forwardMessageContent(message).nonText,
          time: (message) => forwardMessageContent(message).timestampMs,
          send: (message) => onSend(message, target, controller.signal),
          progress: (index, attempt, state) => {
            if (state === 'sent') {
              sent++;
              delivered.add(target.id);
            }
            if (state === 'failed') failed++;
            toast.update(id, {
              title: progress(
                `${target.name} · ${index + 1}/${messages.length}${state === 'sending' ? ` · 第 ${attempt} 次尝试` : state === 'sent' ? ' · 已发送' : ' · 失败'}`,
              ),
            });
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
    }
    toast.update(id, {
      tone: stopped || failed ? 'warning' : 'success',
      title: (
        <span className="weq-forward-banner">
          <span className="weq-forward-banner-label">
            {stopped ? '转发已停止' : '转发完成'} · 已发送 {sent}/{total} 条
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
