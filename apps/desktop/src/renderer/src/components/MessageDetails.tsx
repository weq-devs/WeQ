import { useMemo, useState, type ComponentProps } from 'react';
import { Braces, Copy, Database, FileJson, ListTree, Pencil, X } from 'lucide-react';
import { formatDateTime } from '@weq/time';
import { client, trpc } from '../trpc/client';
import type { Message, Conversation } from '../im-template/template/types';
import type { MessageDetailsSelection } from '../im-template/template/messageContextMenu';
import { copyTextToClipboard } from '../im-template/template/clipboard';
import { renderDefaultMessageContent } from '../im-template/template/messageRenderers';
import { messageContentText } from '../lib/messageClipboard';
import { messageCardJson } from '../lib/messageCardJson';
import { useRenderDocument } from '../lib/renderDocument';
import type { ForwardRecordWire } from '../state/forwardWindow';
import { MessageDecorationCard } from './MessageDecorationCard';
import { MsgElementEditor } from './MsgElementEditor';
import { NumericText } from './NumericText';
import { QqMessageContent } from './QqMessageContent';
import { SegmentedControl } from './SegmentedControl';
import { EmptyState } from './EmptyState';
import { WindowSurface } from './WindowSurface';
import { useToastApi } from './Toast.shared';
import {
  isMessageRecordIdentifier,
  messageRecordField,
  messageSnapshotField,
  snapshotRecordFields,
  type MessageFieldValue,
  type MessageRecordFields,
} from './MessageDetails.shared';
import '../styles/message-details.css';

type Target = Parameters<typeof client.account.messageRecordDetails.query>[0];
type Elements = NonNullable<Message['qqElements']>;
export type MessageRecordEdited = (id: string, elements: Elements) => void;

const tabs = [
  { value: 'body', label: '正文' },
  { value: 'dress', label: '装扮' },
  { value: 'metadata', label: '元数据' },
  { value: 'structure', label: '结构化数据' },
] as const;
type Tab = (typeof tabs)[number]['value'];
const sections = [
  ['elements', '消息元素', ListTree],
  ['card', '卡片载荷', Braces],
  ['cache', '引用与转发快照', FileJson],
  ['row', '原始记录', Database],
] as const;
type Section = (typeof sections)[number][0];
const maxJsonPreview = 64_000;

const emptyTarget: Target = {
  kind: 'c2c',
  conv: '',
  msgId: '0',
  expectedAccountUin: '',
  expectedAccountConfigId: '',
};

function encodeJson(value: unknown) {
  return JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (item?.type === 'Buffer' && Array.isArray(item.data))
        return item.data.map((byte: number) => byte.toString(16).padStart(2, '0')).join('');
      return item;
    },
    2,
  );
}

function isNumericValue(value: string | number) {
  return typeof value === 'number' || /^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(value);
}

function RecordValue({ value, numberFont }: { value: string | number; numberFont: boolean }) {
  return numberFont ? <span className="weq-number weq-number-inherit">{value}</span> : value;
}

function RawField({ value, numberFont }: { value: MessageFieldValue; numberFont: boolean }) {
  const [open, setOpen] = useState(false);
  if (value === null) return 'NULL';
  if (typeof value !== 'object')
    return <RecordValue value={value === '' ? '""' : value} numberFont={numberFont} />;
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <NumericText>{value.bytes.toLocaleString('zh-CN')}</NumericText> 字节 · 十六进制
      </summary>
      {open ? <code className="weq-message-detail-blob">{value.data}</code> : null}
    </details>
  );
}

function Metadata({ record, snapshot }: { record: MessageRecordFields; snapshot?: boolean }) {
  const describe = snapshot ? messageSnapshotField : messageRecordField;
  return (
    <table className="weq-message-detail-table">
      <thead>
        <tr>
          <th>字段</th>
          <th>可读值</th>
          <th>原始值</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(record.columns).map(([field, value]) => {
          const { name, display } = describe(field, value, record);
          const isScalar = typeof value === 'string' || typeof value === 'number';
          const isNickname = snapshot === true && field === 'sendNick';
          const numberFont =
            isScalar &&
            value !== '' &&
            !isNickname &&
            (isMessageRecordIdentifier(field) || isNumericValue(value));
          const directDisplay = isScalar && display === String(value);
          return (
            <tr key={field}>
              <th scope="row">
                {name ? (
                  <>
                    {name}
                    <br />
                  </>
                ) : null}
                <RecordValue value={field} numberFont={isNumericValue(field)} />
              </th>
              <td>
                {display === undefined ? (
                  '—'
                ) : directDisplay ? (
                  <RecordValue value={display} numberFont={numberFont} />
                ) : (
                  <NumericText>{display}</NumericText>
                )}
              </td>
              <td>
                <RawField value={value} numberFont={numberFont} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function MessageDetails({
  selection,
  conversation,
  target,
  snapshot,
  forwardRecord,
  onEdited,
  isSender = false,
  onClose,
}: {
  selection: MessageDetailsSelection;
  conversation?: Conversation;
  target?: Target;
  snapshot?: ForwardRecordWire;
  forwardRecord?: ComponentProps<typeof QqMessageContent>['forwardRecord'];
  onEdited?: MessageRecordEdited;
  isSender?: boolean;
  onClose: () => void;
}) {
  const { message, cardElements } = selection;
  const senderName = message.sender?.displayName || snapshot?.sendNick;
  const [tab, setTab] = useState<Tab>('body');
  const [section, setSection] = useState<Section>(
    selection.cardElements.length ? 'card' : 'elements',
  );
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [updated, setUpdated] = useState<Elements>();
  const document = useRenderDocument();
  const toast = useToastApi();
  const query = trpc.account.messageRecordDetails.useQuery(target ?? emptyTarget, {
    enabled: Boolean(target) && (tab === 'metadata' || tab === 'structure'),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  });
  const record = query.data;
  const localRecord = record?.kind === 'local' ? record : undefined;
  const sourceSnapshot = snapshot ?? (record?.kind === 'cache' ? record.snapshot : undefined);
  const elements = updated ?? message.qqElements ?? [];
  const cards = useMemo(() => {
    if (!updated) return cardElements;
    return cardElements.flatMap((card) => {
      const index = message.qqElements?.indexOf(card) ?? -1;
      return updated[index] ? [updated[index]] : [];
    });
  }, [updated, cardElements, message.qqElements]);
  const canEdit = Boolean(target && onEdited && localRecord?.revision);
  const formatted = useMemo(() => {
    if (tab !== 'structure') return '';
    switch (section) {
      case 'elements':
        return encodeJson(record?.elements ?? elements);
      case 'card':
        return cards.length ? messageCardJson(cards) : '';
      case 'cache':
        return encodeJson(snapshot?.subMsgs ?? localRecord?.cache ?? []);
      case 'row':
        return localRecord
          ? encodeJson({
              table: localRecord.table,
              rowId: localRecord.rowId,
              columns: localRecord.columns,
            })
          : sourceSnapshot
            ? encodeJson(sourceSnapshot)
            : '';
    }
  }, [tab, section, record, localRecord, elements, cards, snapshot, sourceSnapshot]);

  const missingRecord =
    snapshot || message.forwardSnapshot
      ? '转发包里的消息没有独立的数据库记录'
      : message.source === 'roaming'
        ? '这条消息来自漫游缓存'
        : target
          ? '找不到这条消息的数据库记录'
          : '此来源没有可查看的 QQ 数据库记录';

  const copy = async (value: string) => {
    try {
      if (!(await copyTextToClipboard(value, document))) throw new Error('剪贴板写入失败');
      toast.push({ tone: 'success', title: '已复制' });
    } catch {
      toast.push({ tone: 'error', title: '复制失败' });
    }
  };

  const failed =
    query.isError && target ? (
      <EmptyState
        compact
        title="读取数据库记录失败"
        action={
          <button className="weq-set-btn" type="button" onClick={() => void query.refetch()}>
            重试
          </button>
        }
      />
    ) : null;
  const reading = Boolean(target) && query.isInitialLoading;
  const unavailable = reading ? (
    <p role="status">正在读取记录…</p>
  ) : (
    (failed ?? <EmptyState compact title={missingRecord} />)
  );
  const copyLabel = section === 'card' ? '复制卡片 JSON' : '复制 JSON';
  const displayMessage = updated
    ? { ...message, body: messageContentText(updated), qqElements: updated }
    : message;

  return (
    <WindowSurface
      mode="floating"
      centered
      resizeEdges
      width={720}
      title="消息详情"
      className="weq-message-detail"
      dismissOnOutside={false}
      onClose={saving ? undefined : onClose}
    >
      <div className="weq-message-detail-layout">
        <header className="weq-message-detail-header" data-window-drag-handle>
          <strong>消息详情</strong>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            title="关闭"
            disabled={saving}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <div className="weq-message-detail-tabs">
          <SegmentedControl
            label="消息详情"
            options={tabs}
            value={tab}
            disabled={saving}
            onChange={(next) => {
              if (next !== tab) setEditing(false);
              setTab(next);
            }}
          />
        </div>
        <div className="weq-message-detail-content" key={tab}>
          {tab === 'body' ? (
            <div className="weq-message-detail-body">
              <div className="weq-message-detail-body-header">
                <div>
                  <strong>
                    {senderName || <RecordValue value={message.senderId} numberFont />}
                  </strong>
                  {message.createdAt ? (
                    <time dateTime={message.createdAt}>
                      <NumericText>{formatDateTime(message.createdAt, 'second')}</NumericText>
                    </time>
                  ) : null}
                </div>
                <button
                  className="weq-set-btn"
                  type="button"
                  onClick={() => void copy(messageContentText(elements, displayMessage.body))}
                >
                  <Copy size={15} /> 复制正文
                </button>
              </div>
              {elements.some(
                (element) =>
                  element.type && !element.type.startsWith('grayTip') && element.type !== 'unknown',
              ) ? (
                <QqMessageContent
                  elements={elements}
                  sendTimeMs={Date.parse(message.createdAt) || 0}
                  msgId={message.msgId ?? message.id}
                  msgSeq={message.msgSeq}
                  galleryKey={message.id}
                  conversation={conversation}
                  forwardRecord={forwardRecord}
                  isSender={isSender}
                  preserveOrder
                />
              ) : (
                renderDefaultMessageContent(displayMessage)
              )}
            </div>
          ) : null}
          {tab === 'dress' ? (
            <MessageDecorationCard decoration={message.decoration ?? null} />
          ) : null}
          {tab === 'metadata' ? (
            localRecord ? (
              <Metadata record={localRecord} />
            ) : sourceSnapshot ? (
              <Metadata record={snapshotRecordFields(sourceSnapshot)} snapshot />
            ) : (
              unavailable
            )
          ) : null}
          {tab === 'structure' ? (
            <div className="weq-message-detail-structure">
              <nav className="weq-message-detail-nav" aria-label="结构化数据">
                {sections
                  .filter(([id]) => id !== 'card' || cards.length > 0)
                  .filter(
                    ([id]) =>
                      id !== 'cache' || Boolean(snapshot?.subMsgs?.length || record?.cache.length),
                  )
                  .map(([id, name, Icon]) => (
                    <button
                      key={id}
                      type="button"
                      className={`weq-cvs-nav-item${section === id ? ' is-on' : ''}`}
                      aria-current={section === id ? 'true' : undefined}
                      disabled={saving}
                      onClick={() => {
                        setEditing(false);
                        setSection(id);
                      }}
                    >
                      <span className="weq-cvs-nav-icon" aria-hidden="true">
                        <Icon size={16} />
                      </span>
                      <span>
                        {id === 'row' && sourceSnapshot
                          ? snapshot
                            ? '转发快照'
                            : '缓存记录'
                          : name}
                      </span>
                    </button>
                  ))}
              </nav>
              <div className="weq-message-detail-data">
                {formatted || canEdit ? (
                  <div className="weq-message-detail-toolbar">
                    {formatted ? (
                      <button
                        className="weq-set-btn"
                        type="button"
                        onClick={() => void copy(formatted)}
                      >
                        <Copy size={15} /> {copyLabel}
                      </button>
                    ) : null}
                    {section === 'elements' && canEdit && !editing ? (
                      <button
                        className="weq-set-btn"
                        type="button"
                        onClick={() => setEditing(true)}
                      >
                        <Pencil size={15} /> 修改本地记录
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {editing && target && localRecord?.revision ? (
                  <MsgElementEditor
                    embedded
                    msgId={target.msgId}
                    elements={localRecord.elements}
                    onClose={() => setEditing(false)}
                    onSave={async (next) => {
                      if (!localRecord.revision) return;
                      setSaving(true);
                      try {
                        const result = await client.account.editMessageRecord.mutate({
                          ...target,
                          revision: localRecord.revision,
                          elements: next,
                        });
                        setUpdated(result);
                        onEdited?.(message.id, result);
                        await query.refetch();
                      } finally {
                        setSaving(false);
                      }
                    }}
                  />
                ) : formatted ? (
                  <>
                    <pre>{formatted.slice(0, maxJsonPreview)}</pre>
                    {formatted.length > maxJsonPreview ? (
                      <p>预览已截短，可复制完整 JSON。</p>
                    ) : null}
                  </>
                ) : (
                  unavailable
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </WindowSurface>
  );
}
