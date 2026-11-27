import { usePreferenceState } from '../lib/clientPreferences';
import { useId, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight } from 'lucide-react';
import { Modal } from './Dialog';
import { MessageRow } from '../im-template/template/messageRow';
import type { Conversation, Message, User } from '../im-template/template/types';
import type { MessageRenderer } from '../im-template/template/messageRenderers';
import {
  forwardReplyGroupLabel,
  messageBatchLabels,
  type MessageBatchAction,
  type reviewMessageBatch,
} from '../lib/messageBatchAction';
import { useContext } from 'react';
import { ConvContext, ForwardCarrierContext, ForwardKindContext } from '../state/messageContext';
import '../styles/message-batch-action.css';

type Batch = ReturnType<typeof reviewMessageBatch>;
type Group = Batch['groups'][number];

export function MessageBatchActionDialog({
  action,
  batch,
  conversation,
  user,
  renderers,
  deleted,
  renderMessage,
  onContinue,
  onClose,
}: {
  action: MessageBatchAction;
  batch: Batch;
  conversation?: Conversation | null;
  user: User;
  renderers?: MessageRenderer[];
  deleted?: (message: Message) => boolean;
  renderMessage?: (message: Message) => ReactNode;
  onContinue: (messages: Message[], includeReplyExcerpt: boolean) => void;
  onClose: () => void;
}) {
  const id = useId();
  const inheritedCarrier = useContext(ForwardCarrierContext);
  const snapshot = batch.rows[0]?.message.forwardSnapshot;
  const carrier = snapshot
    ? { msgId: snapshot.carrierId, kind: snapshot.kind, resId: snapshot.resId }
    : inheritedCarrier;
  const source: Conversation = conversation ?? {
    id: batch.rows[0]?.message.conversationId ?? '',
    type: 'merged',
    mergedKind: 'hidden',
    title: '聊天记录',
    avatarUrl: null,
    otherUser: null,
    group: null,
    members: [],
    updatedAt: '',
    lastMessage: null,
  };
  const [included, setIncluded] = useState(
    () => new Set(batch.groups.filter((group) => group.include).map((group) => group.key)),
  );
  const [includeReplyExcerpt, setIncludeReplyExcerpt] = usePreferenceState('forwardReplyExcerpt');
  const replyGroup =
    action === 'forward'
      ? batch.groups.find(({ label }) => label === forwardReplyGroupLabel)
      : null;
  const possible = batch.rows.some(({ group }) => !group || group.include !== undefined);
  const selected = batch.rows.flatMap(({ message, group }) =>
    !group || included.has(group.key) ? [message] : [],
  );
  const label = messageBatchLabels[action];
  const blockedLabel =
    action === 'merge' || action === 'forward'
      ? '无法转发'
      : action === 'intent'
        ? '无法分析'
        : action === 'material'
          ? '无法添加'
          : `无法${label.startsWith('复制') ? '复制' : label}`;
  const title = possible
    ? action === 'image' || action === 'text' || action === 'rich' || action === 'json'
      ? `是否复制以下消息${label.slice(2)}`
      : action === 'material'
        ? '是否将以下消息添加到素材库'
        : action === 'intent'
          ? '是否分析以下消息的意图'
          : `是否${label}以下消息`
    : action === 'material'
      ? '以下消息无法添加到素材库'
      : action === 'intent'
        ? '以下消息无法分析意图'
        : `以下消息无法${label}`;
  return (
    <Modal
      width={560}
      centered
      labelledBy={id}
      onClose={onClose}
      dismissOnOutside={false}
      className="weq-message-batch-dialog"
    >
      <div className="weq-dialog">
        <div className="weq-dialog-head">
          <h3 id={id} className="weq-dialog-title">
            {title}
          </h3>
        </div>
        <div className="weq-dialog-body weq-message-batch-groups">
          <ForwardKindContext.Provider
            value={snapshot?.kind ?? (source.type === 'group' ? 'group' : 'c2c')}
          >
            <ConvContext.Provider
              value={snapshot?.conv ?? (source.type === 'group' ? source.id : '')}
            >
              <ForwardCarrierContext.Provider value={carrier}>
                {batch.groups.map((group) => (
                  <MessageBatchGroup
                    key={group.key}
                    group={group}
                    checked={included.has(group.key)}
                    blockedLabel={blockedLabel}
                    replyExcerpt={
                      group === replyGroup
                        ? { checked: includeReplyExcerpt, onChange: setIncludeReplyExcerpt }
                        : undefined
                    }
                    onToggle={() => {
                      setIncluded((previous) => {
                        const next = new Set(previous);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        return next;
                      });
                    }}
                    renderMessage={
                      renderMessage ??
                      ((message) => (
                        <MessageRow
                          message={message}
                          conversation={source}
                          user={user}
                          deleted={deleted?.(message)}
                          renderers={renderers}
                          recallRevokerName={message.recallRevokerName}
                        />
                      ))
                    }
                  />
                ))}
              </ForwardCarrierContext.Provider>
            </ConvContext.Provider>
          </ForwardKindContext.Provider>
        </div>
      </div>
      <footer className="weq-dialog-foot">
        {possible ? (
          <button type="button" className="weq-set-btn" onClick={onClose}>
            取消
          </button>
        ) : null}
        <button
          type="button"
          className="weq-set-btn weq-set-btn-primary"
          data-weq-dialog-confirm
          disabled={possible && !selected.length}
          onClick={
            possible
              ? () =>
                  onContinue(
                    selected,
                    includeReplyExcerpt && !!replyGroup && included.has(replyGroup.key),
                  )
              : onClose
          }
        >
          {possible ? `继续（${selected.length} 条）` : '关闭'}
        </button>
      </footer>
    </Modal>
  );
}

function MessageBatchGroup({
  group,
  checked,
  blockedLabel,
  replyExcerpt,
  onToggle,
  renderMessage,
}: {
  group: Group;
  checked: boolean;
  blockedLabel: string;
  replyExcerpt?: { checked: boolean; onChange: (checked: boolean) => void };
  onToggle: () => void;
  renderMessage: (message: Message) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detail =
    open && group.details.size === group.messages.length
      ? commonDetail(group.details.values())
      : undefined;
  return (
    <div className="weq-message-batch-group">
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary
          className="weq-message-batch-summary"
          data-switch={group.include !== undefined || undefined}
        >
          <ChevronRight className="weq-message-batch-chevron" size={16} aria-hidden />
          <span>
            {group.label}（{group.messages.length} 条）
          </span>
          {group.include === undefined ? (
            <span className="weq-message-batch-blocked">{blockedLabel}</span>
          ) : null}
        </summary>
        {open ? (
          <div className="weq-message-batch-expanded">
            {detail ? <p>{detail}</p> : null}
            <BatchPreview
              messages={group.messages}
              label={group.label}
              renderMessage={
                detail
                  ? renderMessage
                  : (message) => (
                      <>
                        {renderMessage(message)}
                        {group.details.has(message.id) ? (
                          <p className="weq-message-batch-note">{group.details.get(message.id)}</p>
                        ) : null}
                      </>
                    )
              }
            />
          </div>
        ) : null}
      </details>
      {group.include !== undefined ? (
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          aria-label={`纳入${group.label}`}
          className={`weq-message-batch-switch switch-control${checked ? ' on' : ''}`}
          onClick={onToggle}
        >
          <span />
        </button>
      ) : null}
      {replyExcerpt ? (
        <div className="weq-message-batch-reply-excerpt">
          <span aria-hidden>无法跳转时附上引用摘录</span>
          <button
            type="button"
            role="switch"
            aria-checked={replyExcerpt.checked && checked}
            aria-label="无法跳转时附上引用摘录"
            className={`switch-control${replyExcerpt.checked && checked ? ' on' : ''}`}
            disabled={!checked}
            onClick={() => replyExcerpt.onChange(!replyExcerpt.checked)}
          >
            <span />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function commonDetail(values: Iterable<string>) {
  let first: string | undefined;
  for (const value of values) {
    if (first === undefined) first = value;
    else if (first !== value) return undefined;
  }
  return first;
}

function BatchPreview({
  messages,
  label,
  renderMessage,
}: {
  messages: Message[];
  label: string;
  renderMessage: (message: Message) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const windowed = messages.length > 40;
  const list = useVirtualizer({
    count: messages.length,
    enabled: windowed,
    getScrollElement: () => ref.current,
    estimateSize: () => 76,
    getItemKey: (index) => messages[index]!.id,
    overscan: 5,
  });
  return (
    <div
      ref={ref}
      className="weq-message-batch-preview message-scroll"
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {windowed ? (
        <div style={{ height: list.getTotalSize(), position: 'relative' }}>
          {list.getVirtualItems().map((row) => (
            <div
              key={row.key}
              data-index={row.index}
              ref={list.measureElement}
              className="weq-message-batch-preview-row"
              style={{ position: 'absolute', insetInline: 0, top: row.start }}
            >
              {renderMessage(messages[row.index]!)}
            </div>
          ))}
        </div>
      ) : (
        messages.map((message) => (
          <div key={message.id} className="weq-message-batch-preview-row">
            {renderMessage(message)}
          </div>
        ))
      )}
    </div>
  );
}
