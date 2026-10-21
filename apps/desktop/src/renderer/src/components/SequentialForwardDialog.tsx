import { useMemo, useRef, useState } from 'react';
import { Eye, Forward, X } from 'lucide-react';
import { Modal } from './Dialog';
import { MergeForwardTargets } from './mergeForward/MergeForwardTargets';
import type { MfTarget } from './mergeForward/model';
import type { Conversation, Message, User } from '../im-template/template/types';
import {
  composeMessageRenderers,
  type MessageRenderer,
} from '../im-template/template/messageRenderers';
import {
  DEFAULT_FORWARD_OPTIONS,
  estimateForwardDuration,
  formatForwardDuration,
  forwardMessageContent,
} from '../lib/sequentialForward';
import { startSequentialForward } from './SequentialForwardTask';
import { forwardUnsupportedReason } from '../lib/messageRepeat';
import { GapMessagesModal } from './compose/GapMessagesModal';
import { qqMessageRenderer } from './QqMessageContent';
import '../styles/sequential-forward.css';

const previewRenderers = composeMessageRenderers({ prepend: [qqMessageRenderer] });
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
  onSend,
  onClose,
  onOpenTarget,
  user = unknownUser,
  conversation,
  renderers = previewRenderers,
}: {
  messages: readonly Message[];
  targets: MfTarget[];
  onSend: (message: Message, target: MfTarget, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
  onOpenTarget: (target: MfTarget) => void;
  user?: User;
  conversation?: Conversation;
  renderers?: MessageRenderer[];
}) {
  const [selected, setSelected] = useState(new Set<string>());
  const [options, setOptions] = useState(DEFAULT_FORWARD_OPTIONS);
  const [error, setError] = useState('');
  const submitted = useRef(false);
  const [started, setStarted] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [previewCount, setPreviewCount] = useState(50);
  const picked = targets.filter((target) => selected.has(target.id));
  const prepared = useMemo(() => {
    const sendable: Message[] = [];
    const ignored: { message: Message; reason: string }[] = [];
    messages.forEach((message) => {
      const reason = forwardUnsupportedReason(message.qqElements ?? []);
      if (reason) ignored.push({ message, reason });
      else sendable.push(message);
    });
    return {
      sendable,
      ignored,
      reasons: new Map(ignored.map(({ message, reason }) => [message, reason])),
    };
  }, [messages]);
  const content = useMemo(() => prepared.sendable.map(forwardMessageContent), [prepared]);
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
  const send = (confirmed = false) => {
    if (submitted.current || invalid || !picked.length || !prepared.sendable.length) return;
    if (prepared.ignored.length && !confirmed) {
      setReviewOpen(true);
      return;
    }
    try {
      submitted.current = true;
      startSequentialForward({
        messages: prepared.sendable,
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
  const previewConversation: Conversation = conversation ?? {
    id: messages[0]?.conversationId ?? 'forward-preview',
    type: 'merged',
    mergedKind: 'hidden',
    title: '将跳过的消息',
    avatarUrl: null,
    otherUser: null,
    group: null,
    members: [],
    updatedAt: '',
    lastMessage: null,
  };
  return (
    <Modal
      onClose={onClose}
      dismissOnOutside={false}
      labelledBy={reviewOpen ? 'weq-gap-messages-title' : 'weq-forward-title'}
      width={520}
    >
      <div className={`weq-sequential-forward${reviewOpen ? ' weq-forward-review' : ''}`}>
        {!reviewOpen ? (
          <header>
            <strong id="weq-forward-title">
              {messages.length === 1 ? '转发消息' : `逐条转发 · ${messages.length} 条`}
            </strong>
            <button type="button" title="关闭" aria-label="关闭" onClick={onClose}>
              <X size={17} />
            </button>
          </header>
        ) : null}
        {reviewOpen ? (
          <div className="weq-forward-ignored">
            <GapMessagesModal
              conversation={previewConversation}
              user={user}
              renderers={renderers}
              messages={prepared.ignored.slice(-previewCount).map(({ message }) => message)}
              loading={false}
              loadingMore={false}
              error={null}
              moreFailed={false}
              hasMore={previewCount < prepared.ignored.length}
              totalCount={prepared.ignored.length}
              notice={`以下 ${prepared.ignored.length} 条消息无法等价重发，将整条跳过；其余 ${prepared.sendable.length} 条按原顺序发送。`}
              title="预览将跳过的消息"
              backLabel="返回转发设置"
              messageNotice={(message) => prepared.reasons.get(message)}
              onLoadMore={() => setPreviewCount((value) => value + 50)}
              onClose={() => setReviewOpen(false)}
              preview
              embedded
            />
          </div>
        ) : (
          <div className="weq-forward-config">
            <fieldset disabled={started}>
              <MergeForwardTargets targets={targets} selected={selected} onChange={setSelected} />
              {prepared.ignored.length ? (
                <button
                  type="button"
                  className="weq-forward-ignored-summary"
                  onClick={() => setReviewOpen(true)}
                >
                  <Eye size={14} />
                  查看将跳过的 {prepared.ignored.length} 条消息
                </button>
              ) : null}
              <div className="weq-forward-options">
                {prepared.sendable.length > 1 ? (
                  <>
                    <label>
                      间隔方式
                      <select
                        value={options.mode}
                        onChange={(event) =>
                          setOptions({
                            ...options,
                            mode:
                              event.target.value === 'text'
                                ? 'text'
                                : event.target.value === 'original'
                                  ? 'original'
                                  : 'fixed',
                          })
                        }
                      >
                        <option value="fixed">固定间隔</option>
                        <option value="text">按文本长度</option>
                        <option value="original">参考原消息间隔</option>
                      </select>
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
                              options.mode === 'fixed'
                                ? options.intervalMs
                                : options.msPerCharacter,
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
        )}
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
            data-forward-confirm-ignore={reviewOpen || undefined}
            disabled={
              started || Boolean(invalid) || picked.length === 0 || prepared.sendable.length === 0
            }
            title={
              started
                ? '正在转发，请稍后'
                : invalid ||
                  (!prepared.sendable.length
                    ? '没有可转发的消息'
                    : !picked.length
                      ? '请选择至少一个目标会话'
                      : '发送所选消息')
            }
            onClick={() => send(reviewOpen)}
          >
            <Forward size={16} />
            {reviewOpen ? '跳过并发送' : '发送'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
