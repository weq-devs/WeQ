import { NumericText } from './NumericText';
import { useMemo, useRef, useState } from 'react';
import { Forward, X } from 'lucide-react';
import { Modal } from './Dialog';
import { MergeForwardTargets } from './mergeForward/MergeForwardTargets';
import type { MfTarget } from './mergeForward/model';
import type { Message, User } from '../im-template/template/types';
import {
  DEFAULT_FORWARD_OPTIONS,
  estimateForwardDuration,
  formatForwardDuration,
  forwardMessageContent,
} from '../lib/sequentialForward';
import { startSequentialForward, type SequentialForwardSend } from './SequentialForwardTask';
import type { ForwardChatKind } from '../lib/sequentialForwardReply';
import { trpc } from '../trpc/client';
import '../styles/sequential-forward.css';

const unknownUser: User = {
  id: '',
  identityLabel: 'QQ',
  identityValue: '',
  username: '',
  displayName: '未知用户',
  avatarUrl: null,
};

export function SequentialForwardDialog({
  messages,
  targets,
  sourceKind,
  includeExcerpt,
  onSend,
  onClose,
  onOpenTarget,
  user = unknownUser,
}: {
  messages: readonly Message[];
  targets: MfTarget[];
  sourceKind?: ForwardChatKind;
  includeExcerpt?: boolean;
  onSend: SequentialForwardSend;
  onClose: () => void;
  onOpenTarget: (target: MfTarget) => void;
  user?: User;
}) {
  const accountConfig = trpc.account.getAccountConfig.useQuery();
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
    const duration = estimateForwardDuration(content, options, 1);
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
      if (!accountConfig.data?.configId || accountConfig.data.uin !== user.identityValue)
        throw new Error('账号配置尚未就绪，请重新打开转发窗口');
      submitted.current = true;
      startSequentialForward({
        scope: { uin: accountConfig.data.uin, configId: accountConfig.data.configId },
        messages,
        targets: picked,
        sourceKind,
        includeExcerpt,
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
            {messages.length === 1 ? (
              '转发消息'
            ) : (
              <NumericText>{`逐条转发 · ${messages.length} 条`}</NumericText>
            )}
          </strong>
          <button type="button" title="关闭" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </header>
        <div className="weq-forward-config">
          <fieldset disabled={started}>
            <MergeForwardTargets targets={targets} selected={selected} onChange={setSelected} />
            <div className="weq-forward-options">
              {messages.length > 1 ? (
                <>
                  <label>
                    间隔方式
                    <SegmentedControl
                      label="间隔方式"
                      value={options.mode}
                      onChange={(mode) => setOptions({ ...options, mode })}
                      options={[
                        { value: 'fixed', label: '固定间隔' },
                        { value: 'text', label: '按文本长度' },
                        { value: 'original', label: '原消息间隔' },
                      ]}
                    />
                  </label>
                  {options.mode === 'text' ? (
                    <label>
                      非文本消息耗时（秒）
                      <input
                        type="number"
                        min={0}
                        max={3600}
                        step={0.001}
                        value={Number.isFinite(options.nonTextMs) ? options.nonTextMs / 1000 : ''}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            nonTextMs: Math.round(event.target.valueAsNumber * 1000),
                          })
                        }
                      />
                    </label>
                  ) : null}
                  {options.mode !== 'original' ? (
                    <label>
                      {options.mode === 'fixed' ? '间隔（秒）' : '每字间隔（秒）'}
                      <input
                        type="number"
                        min={0}
                        max={3600}
                        step={0.001}
                        value={
                          Number.isFinite(
                            options.mode === 'fixed' ? options.intervalMs : options.msPerCharacter,
                          )
                            ? options.mode === 'fixed'
                              ? options.intervalMs / 1000
                              : options.msPerCharacter / 1000
                            : ''
                        }
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            [options.mode === 'fixed' ? 'intervalMs' : 'msPerCharacter']:
                              Math.round(event.target.valueAsNumber * 1000),
                          })
                        }
                      />
                    </label>
                  ) : null}
                  <label>
                    随机抖动 ± 秒
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      step={0.001}
                      value={Number.isFinite(options.jitterMs) ? options.jitterMs / 1000 : ''}
                      onChange={(event) =>
                        setOptions({
                          ...options,
                          jitterMs: Math.round(event.target.valueAsNumber * 1000),
                        })
                      }
                    />
                  </label>
                  {options.mode !== 'fixed' ? (
                    <label>
                      每条消息的最大间隔（秒，-1 为不限）
                      <input
                        type="number"
                        min={-1}
                        max={3600}
                        step={0.001}
                        value={
                          Number.isFinite(options.maxIntervalMs)
                            ? options.maxIntervalMs === -1
                              ? -1
                              : options.maxIntervalMs / 1000
                            : ''
                        }
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            maxIntervalMs:
                              event.target.valueAsNumber === -1
                                ? -1
                                : event.target.valueAsNumber < 0
                                  ? Number.NaN
                                  : Math.round(event.target.valueAsNumber * 1000),
                          })
                        }
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
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
                <SegmentedControl
                  label="失败后"
                  value={options.failure}
                  onChange={(failure) => setOptions({ ...options, failure })}
                  options={[
                    { value: 'abort', label: '中止' },
                    { value: 'skip', label: '忽略并继续' },
                  ]}
                />
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
            预计用时 {estimate || '—'}
          </span>
          <button
            type="button"
            className="weq-action-primary"
            data-weq-dialog-confirm
            disabled={started || Boolean(invalid) || picked.length === 0 || messages.length === 0}
            title={
              started
                ? '正在转发，请稍后'
                : invalid ||
                  (!messages.length
                    ? '没有可转发的消息'
                    : !picked.length
                      ? '请选择至少一个目标会话'
                      : '发送所选消息')
            }
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
import { SegmentedControl } from './SegmentedControl';
