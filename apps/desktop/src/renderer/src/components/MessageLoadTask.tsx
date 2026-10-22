import { Square } from 'lucide-react';
import { useToast } from './Toast';
import '../styles/message-load-task.css';

/** 历史／漫游加载按实际收到的消息条数报告，不借用逐条发送的时间进度。 */
export async function runMessageLoadTask<T>(
  label: string,
  run: (report: (count: number) => void, signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  outerSignal?.throwIfAborted();
  outerSignal?.addEventListener('abort', abort, { once: true });
  const toast = useToast.getState();
  let count = 0;
  const content = () => (
    <span className="weq-message-load-task">
      <span>
        {label} · 已加载 {count} 条消息
      </span>
      <span className="weq-message-load-actions">
        <progress aria-label="消息加载进度" />
        <button type="button" aria-label="停止消息加载" title="停止后续消息加载" onClick={abort}>
          <Square size={14} />
        </button>
      </span>
    </span>
  );
  const id = toast.push({ title: content(), ttl: 0, dismissible: false });
  let rejectOnAbort!: () => void;
  // 在途 IPC 不一定响应取消；先结束前端等待，迟到页面仍由 signal 拦截。
  const stopped = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason);
  });
  controller.signal.addEventListener('abort', rejectOnAbort, { once: true });
  try {
    const result = await Promise.race([
      run((delta) => {
        controller.signal.throwIfAborted();
        if (!Number.isSafeInteger(delta) || delta < 0) throw new Error('消息加载计数无效');
        count += delta;
        toast.update(id, { title: content() });
      }, controller.signal),
      stopped,
    ]);
    controller.signal.throwIfAborted();
    toast.update(id, {
      tone: 'success',
      title: `${label}完成 · 已加载 ${count} 条消息`,
      ttl: 0,
      dismissible: true,
    });
    return result;
  } catch (error) {
    toast.update(id, {
      tone: 'warning',
      title: `${controller.signal.aborted ? '已停止' : `${label}失败`} · 已加载 ${count} 条消息`,
      detail: controller.signal.aborted
        ? null
        : error instanceof Error
          ? error.message
          : String(error),
      ttl: 0,
      dismissible: true,
    });
    throw error;
  } finally {
    controller.signal.removeEventListener('abort', rejectOnAbort);
    outerSignal?.removeEventListener('abort', abort);
  }
}
