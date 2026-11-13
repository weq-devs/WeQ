import { eventTimeFormatter } from '@weq/time';
import { useRef, type ReactElement } from 'react';
import { useSearchTargetFocus } from '../hooks/useSearchTargetFocus';
import { FileText, RefreshCw, X } from 'lucide-react';
import { albumMediaUrl } from '../lib/resourceUrl';
import { GroupFeatureSurface, type GroupFeaturePresentation } from './GroupFeatureSurface';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { useQQGroupPermissions } from './qq-actions/shared';
import {
  essenceActive,
  essenceSource,
  ESSENCE_RECEIPT_TTL,
  useQQEssence,
} from '../state/qqEssence';
import { qqEssenceTargetParts } from '../lib/qqEssenceTarget';
import { QQEssenceAction } from './QQMessageEssenceAction';
import '../styles/group-essence-actions.css';
import { ContactEmptyState } from './contactProfile/ContactRow';

/** 显示用的群精华数据（已转换） */
export interface GroupEssenceWire {
  id: string;
  msgSeq: number;
  msgRandom?: number;
  senderName: string;
  operatorName: string;
  createdAt: string;
  active: boolean;
  content?: Array<{
    type: number;
    text?: string;
    faceIndex?: number;
    imageUrl?: string;
    fileName?: string;
    fileSize?: number | string;
  }>;
  senderTime?: number;
  canRemove?: boolean;
}

export function GroupEssenceDialog({
  embedded,
  anchor,
  presentation,
  groupCode,
  groupName,
  essenceMessages,
  loading,
  onlineError,
  onClose,
  onJumpToMessage,
  initialMsgSeq,
  loadMore,
}: {
  embedded?: boolean;
  anchor?: HTMLElement | null;
  presentation?: GroupFeaturePresentation;
  groupCode: string;
  groupName: string;
  essenceMessages?: GroupEssenceWire[];
  /** 是否正在拉取（数据库 / 联网） — 首次打开时避免闪现“暂无群精华”。 */
  loading?: boolean;
  onlineError?: boolean;
  onClose: () => void;
  onJumpToMessage?: (seq: number) => void;
  initialMsgSeq?: number;
  loadMore?: { loading: boolean; onLoad: () => void };
}): ReactElement {
  const root = useRef<HTMLElement>(null);
  const session = useQQWriteSession(`essence-list:${groupCode}`);
  const permissions = useQQGroupPermissions(Number(groupCode), session);
  const receipts = useQQEssence((state) => state.receipts);
  const source = essenceSource(session.binding);
  const recent = Object.values(receipts).filter(
    (receipt) =>
      receipt.source === source &&
      receipt.groupId === Number(groupCode) &&
      receipt.enabled !== undefined &&
      Date.now() - receipt.at < ESSENCE_RECEIPT_TTL,
  );
  const visible: GroupEssenceWire[] = (essenceMessages ?? []).filter((item) =>
    essenceActive(receipts, source, Number(groupCode), item.msgSeq, item.active),
  );
  for (const receipt of recent) {
    if (receipt.enabled && !visible.some((item) => item.msgSeq === receipt.sequence))
      visible.unshift({
        id: `receipt:${receipt.sequence}`,
        msgSeq: receipt.sequence,
        msgRandom: receipt.random,
        senderName: `消息 ${receipt.sequence}`,
        operatorName: '',
        createdAt: new Date(receipt.at).toISOString(),
        active: true,
      });
  }
  useSearchTargetFocus(
    root,
    'data-essence-seq',
    initialMsgSeq === undefined ? undefined : String(initialMsgSeq),
    visible.length > 0,
  );
  return (
    <GroupFeatureSurface
      embedded={embedded}
      presentation={presentation}
      anchor={anchor}
      title="群精华"
      className="modal-scrim group-essence-scrim"
      onClose={onClose}
    >
      <section
        ref={root}
        className="group-essence-dialog"
        role={embedded ? 'region' : 'dialog'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>群精华</strong>
            <span>{groupName}</span>
          </div>
          <button
            className="icon-button"
            type="button"
            title="关闭群精华"
            aria-label="关闭群精华"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        <div className="group-essence-body">
          {onlineError && (
            <p className="weq-essence-receipt" role="status">
              联网精华读取失败，当前仅显示本地记录
            </p>
          )}
          {loading && visible.length === 0 ? (
            <div className="group-essence-empty is-loading">
              <RefreshCw size={22} className="weq-gap-spin" />
              <span>正在拉取群精华…</span>
            </div>
          ) : visible.length > 0 ? (
            <div className="group-essence-list">
              {visible.map((item) => {
                const canJump = Boolean(
                  onJumpToMessage && Number.isSafeInteger(item.msgSeq) && item.msgSeq > 0,
                );
                return (
                  <article
                    key={item.id}
                    data-essence-seq={item.msgSeq}
                    className={`group-essence-item${canJump ? ' is-clickable' : ''}`}
                  >
                    <button
                      type="button"
                      className="weq-essence-jump"
                      title={canJump ? '跳转到消息' : '缺少可用的消息序号'}
                      onClick={() => {
                        if (canJump) {
                          onClose();
                          onJumpToMessage?.(item.msgSeq);
                        }
                      }}
                      disabled={!canJump}
                    >
                      <header className="group-essence-header">
                        <span className="group-essence-sender">{item.senderName || 'Member'}</span>
                        <span className="group-essence-meta">
                          {formatShortDate(item.createdAt)}
                          {item.operatorName ? ` · ${item.operatorName}` : ''}
                        </span>
                      </header>

                      {item.content && item.content.length > 0 ? (
                        <div className="group-essence-content">
                          {item.content.map((element, idx) => {
                            const elementKey = `${item.id}-${element.type}-${element.text || element.imageUrl || element.fileName || idx}`;
                            return (
                              <div key={elementKey} className="group-essence-element">
                                {element.type === 1 && element.text ? (
                                  <p className="essence-text">{element.text}</p>
                                ) : element.type === 2 && element.faceIndex !== undefined ? (
                                  <span className="essence-face">[表情{element.faceIndex}]</span>
                                ) : element.type === 3 && element.imageUrl ? (
                                  <img
                                    src={albumMediaUrl(element.imageUrl)}
                                    alt="精华消息图片"
                                    className="essence-image"
                                    loading="lazy"
                                  />
                                ) : element.type === 5 && element.fileName ? (
                                  <div className="essence-file">
                                    <FileText size={14} aria-hidden /> {element.fileName}
                                    {element.fileSize
                                      ? ` (${formatFileSize(element.fileSize)})`
                                      : ''}
                                  </div>
                                ) : (
                                  <span className="essence-unknown">[类型 {element.type}]</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="group-essence-placeholder">
                          {item.active ? '已设为精华' : '已取消精华'}
                        </p>
                      )}
                    </button>
                    <div className="weq-essence-actions">
                      <QQEssenceAction
                        target={qqEssenceTargetParts(
                          groupCode,
                          String(item.msgSeq),
                          item.msgRandom === undefined ? undefined : String(item.msgRandom),
                        )}
                        initialActive
                        allowed={
                          item.canRemove === true ||
                          (item.canRemove === undefined && Boolean(permissions.data?.canManage))
                        }
                        iconOnly
                      />
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <ContactEmptyState>
              {onlineError
                ? '本地未找到群精华，联网结果暂时不可用。'
                : '还没有群精华。本地与当前联网页都未找到记录。'}
            </ContactEmptyState>
          )}
          {loadMore ? (
            <button
              type="button"
              className="weq-group-text-action"
              disabled={loadMore.loading}
              onClick={loadMore.onLoad}
            >
              加载更多精华
            </button>
          ) : null}
        </div>
      </section>
    </GroupFeatureSurface>
  );
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return '';
  return eventTimeFormatter.format(date);
}

function formatFileSize(size: number | string | undefined): string {
  if (size == null) return '';
  const bytes = typeof size === 'string' ? Number(size) : size;
  if (Number.isNaN(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
