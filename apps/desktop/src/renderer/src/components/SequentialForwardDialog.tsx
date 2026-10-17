import { useEffect, useRef, useState } from 'react';
import { Forward, Loader2, X } from 'lucide-react';
import { Modal } from './Dialog';
import { MergeForwardTargets } from './mergeForward/MergeForwardTargets';
import type { MfTarget } from './mergeForward/model';
import type { Message } from '../im-template/template/types';
import type { RepeatElement } from '../lib/messageRepeat';
import { DEFAULT_FORWARD_OPTIONS, forwardSequentially } from '../lib/sequentialForward';
import '../styles/sequential-forward.css';

export function SequentialForwardDialog({
  messages,
  targets,
  onSend,
  onClose,
}: {
  messages: readonly Message[];
  targets: MfTarget[];
  onSend: (message: Message, target: MfTarget, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState(new Set<string>());
  const [options, setOptions] = useState(DEFAULT_FORWARD_OPTIONS);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const accepted = useRef(new Set<string>());
  useEffect(() => () => controller.current?.abort(), []);
  const close = () => {
    if (running) controller.current?.abort();
    else onClose();
  };
  const send = async () => {
    if (controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    const picked = targets.filter((target) => selected.has(target.id));
    setRunning(true);
    setError('');
    try {
      let sent = 0,
        failed = 0;
      for (const target of picked) {
        const result = await forwardSequentially(messages, options, {
          signal: abort.signal,
          text: (message) =>
            ((message as Message & { qqElements?: RepeatElement[] }).qqElements ?? [])
              .filter((element) => element.type === 'text')
              .map((element) => String(element.data?.textContent ?? ''))
              .join(''),
          send: async (message) => {
            const key = `${target.id}:${message.id}`;
            if (accepted.current.has(key)) return;
            await onSend(message, target, abort.signal);
            accepted.current.add(key);
          },
          progress: (index, attempt, state) =>
            setStatus(
              `${target.name} · ${index + 1}/${messages.length}${state === 'sending' ? ` · 第 ${attempt} 次尝试` : state === 'sent' ? ' · 已发送' : ' · 失败'}`,
            ),
        });
        sent += result.sent;
        failed += result.failed;
      }
      setStatus(`已发送 ${sent} 条${failed ? `，失败 ${failed} 条` : ''}`);
      setCompleted(true);
    } catch (cause) {
      setError(
        abort.signal.aborted
          ? '已停止，已发出的消息不会撤回'
          : cause instanceof Error
            ? cause.message
            : String(cause),
      );
    } finally {
      controller.current = null;
      setRunning(false);
    }
  };
  return (
    <Modal onClose={close} labelledBy="weq-forward-title" width={520}>
      <div className="weq-sequential-forward">
        <header>
          <strong id="weq-forward-title">
            {messages.length === 1 ? '转发消息' : `逐条转发 · ${messages.length} 条`}
          </strong>
          <button
            type="button"
            title={running ? '停止后续发送' : '关闭'}
            aria-label={running ? '停止后续发送' : '关闭'}
            onClick={close}
          >
            <X size={17} />
          </button>
        </header>
        <fieldset disabled={running || completed}>
          <MergeForwardTargets targets={targets} selected={selected} onChange={setSelected} />
          <div className="weq-forward-options">
            <label>
              间隔方式
              <select
                value={options.mode}
                onChange={(event) =>
                  setOptions({ ...options, mode: event.target.value === 'text' ? 'text' : 'fixed' })
                }
              >
                <option value="fixed">固定间隔</option>
                <option value="text">按文本长度</option>
              </select>
            </label>
            <label>
              {options.mode === 'fixed' ? '间隔（毫秒）' : '每字间隔（毫秒）'}
              <input
                type="number"
                min={0}
                max={3600000}
                value={options.mode === 'fixed' ? options.intervalMs : options.msPerCharacter}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    [options.mode === 'fixed' ? 'intervalMs' : 'msPerCharacter']:
                      event.target.valueAsNumber,
                  })
                }
              />
            </label>
            <label>
              随机抖动 ± 毫秒
              <input
                type="number"
                min={0}
                max={3600000}
                value={options.jitterMs}
                onChange={(event) =>
                  setOptions({ ...options, jitterMs: event.target.valueAsNumber })
                }
              />
            </label>
            <label>
              单条最大尝试次数
              <input
                type="number"
                min={1}
                max={20}
                value={options.maxAttempts}
                onChange={(event) =>
                  setOptions({ ...options, maxAttempts: event.target.valueAsNumber })
                }
              />
            </label>
            <label>
              失败后
              <select
                value={options.failure}
                onChange={(event) =>
                  setOptions({
                    ...options,
                    failure: event.target.value === 'skip' ? 'skip' : 'abort',
                  })
                }
              >
                <option value="abort">中止</option>
                <option value="skip">忽略并继续</option>
              </select>
            </label>
          </div>
        </fieldset>
        {status ? (
          <div role="status" className="weq-forward-status">
            {running ? <Loader2 size={15} className="spin" /> : null}
            {status}
          </div>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <footer>
          <button
            type="button"
            className="weq-action-primary"
            disabled={running || completed || selected.size === 0}
            onClick={() => void send()}
          >
            <Forward size={16} />
            {completed ? '已结束' : '发送'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
