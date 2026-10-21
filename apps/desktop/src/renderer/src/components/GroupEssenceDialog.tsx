import type { ReactElement } from 'react';
import { RefreshCw, Sparkles, X } from 'lucide-react';
import { albumMediaUrl } from '../lib/resourceUrl';
import { OverlayLayer } from './OverlayLayer';
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
  groupCode,
  groupName,
  essenceMessages,
  loading,
  onlineError,
  onClose,
  onJumpToMessage,
}: {
  groupCode: string;
  groupName: string;
  essenceMessages?: GroupEssenceWire[];
  /** 是否正在拉取（数据库 / 联网） — 首次打开时避免闪现“暂无群精华”。 */
  loading?: boolean;
  onlineError?: boolean;
  onClose: () => void;
  onJumpToMessage?: (seq: number) => void;
}): ReactElement {
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
  return (
    <OverlayLayer
      presentation="sidecar"
      title="群精华"
      className="modal-scrim group-essence-scrim"
      onClose={onClose}
    >
      <section
        className="group-essence-dialog"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>群精华</strong>
            <span>{groupName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
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
                                    📎 {element.fileName}
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
            <div className="group-essence-empty">
              <Sparkles size={22} />
              <span>暂无群精华</span>
              <small>
                {onlineError
                  ? '本地未找到有效记录，联网结果暂不可用'
                  : '本地与当前联网页暂无有效记录'}
              </small>
            </div>
          )}
        </div>
      </section>
    </OverlayLayer>
  );
}

function formatShortDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
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
