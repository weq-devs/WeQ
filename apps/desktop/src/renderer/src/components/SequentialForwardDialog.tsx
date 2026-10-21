import { useMemo, useRef, useState } from 'react';
import { Forward, X } from 'lucide-react';
import { Modal } from './Dialog';
import { MergeForwardTargets } from './mergeForward/MergeForwardTargets';
import type { MfTarget } from './mergeForward/model';
import type { Message } from '../im-template/template/types';
import {
  DEFAULT_FORWARD_OPTIONS,
  estimateForwardDuration,
  formatForwardDuration,
  forwardMessageContent,
} from '../lib/sequentialForward';
import { startSequentialForward } from './SequentialForwardTask';
import '../styles/sequential-forward.css';

export function SequentialForwardDialog({
  messages,
  targets,
  onSend,
  onClose,
  onOpenTarget,
}: {
  messages: readonly Message[];
  targets: MfTarget[];
  onSend: (message: Message, target: MfTarget, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
  onOpenTarget: (target: MfTarget) => void;
}) {
  const [selected, setSelected] = useState(new Set<string>());
  const [options, setOptions] = useState(DEFAULT_FORWARD_OPTIONS);
  const [error, setError] = useState('');
  const submitted = useRef(false);
  const [started, setStarted] = useState(false);
  const picked = targets.filter((target) => selected.has(target.id));
  const content = useMemo(() => messages.map(forwardMessageContent), [messages]);
  let estimate = '';
  let invalid = '';
  try {
    const duration = estimateForwardDuration(content, options, picked.length);
    estimate =
      duration.minMs === duration.maxMs
        ? formatForwardDuration(duration.minMs)
        : `${formatForwardDuration(duration.minMs)} – ${formatForwardDuration(duration.maxMs)}`;
  } catch (cause) {
    invalid = cause instanceof Error ? cause.message : String(cause);
  }
  const send = () => {
    if (submitted.current || invalid || !picked.length || !messages.length) return;
    try {
      submitted.current = true;
      startSequentialForward({
        messages: [...messages],
        targets: picked,
        options: { ...options },
        onSend,
        onOpenTarget,
      });
      setStarted(true);
      onClose();
    } catch (cause) {
      submitted.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <Modal onClose={onClose} dismissOnOutside={false} labelledBy="weq-forward-title" width={520}>
      <div className="weq-sequential-forward">
        <header>
          <strong id="weq-forward-title">
            {messages.length === 1 ? '转发消息' : `逐条转发 · ${messages.length} 条`}
          </strong>
          <button type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="weq-forward-config">
          <fieldset disabled={started}>
            <MergeForwardTargets targets={targets} selected={selected} onChange={setSelected} />
            <div className="weq-forward-options">
              <label>
                间隔方式
                <select
                  value={options.mode}
                  onChange={(event) =>
                    setOptions({
                      ...options,
                      mode: event.target.value === 'text' ? 'text' : 'fixed',
                    })
                  }
                >
                  <option value="fixed">固定间隔</option>
                  <option value="text">按文本长度</option>
                </select>
              </label>
              {options.mode === 'text' ? (
                <label>
                  非文本消息耗时（毫秒）
                  <input
                    type="number"
                    min={0}
                    max={3600000}
                    step={1}
                    value={Number.isFinite(options.nonTextMs) ? options.nonTextMs : ''}
                    onChange={(event) =>
                      setOptions({ ...options, nonTextMs: event.target.valueAsNumber })
                    }
                  />
                </label>
              ) : null}
              <label>
                {options.mode === 'fixed' ? '间隔（毫秒）' : '每字间隔（毫秒）'}
                <input
                  type="number"
                  min={0}
                  max={3600000}
                  value={
                    Number.isFinite(
                      options.mode === 'fixed' ? options.intervalMs : options.msPerCharacter,
                    )
                      ? options.mode === 'fixed'
                        ? options.intervalMs
                        : options.msPerCharacter
                      : ''
                  }
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
                  value={Number.isFinite(options.jitterMs) ? options.jitterMs : ''}
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
                  value={Number.isFinite(options.maxAttempts) ? options.maxAttempts : ''}
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
        </div>
        {error || invalid ? <p role="alert">{error || invalid}</p> : null}
        <footer>
          <span
            className="weq-forward-estimate"
            role="status"
            title="预估仅包含配置的等待时间，不含上传、网络回执和重试耗时"
          >
            预计用时 {picked.length ? estimate || '—' : '—'}
          </span>
          <button
            type="button"
            className="weq-action-primary"
            disabled={started || Boolean(invalid) || picked.length === 0 || messages.length === 0}
            onClick={send}
          >
            <Forward size={16} />
            发送
          </button>
        </footer>
      </div>
    </Modal>
  );
}
