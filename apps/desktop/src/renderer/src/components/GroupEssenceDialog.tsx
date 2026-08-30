// @ts-nocheck
import type { ReactElement } from 'react';
import { RefreshCw, Sparkles, X } from 'lucide-react';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import { albumMediaUrl } from '../lib/resourceUrl';

/** 显示用的群精华数据（已转换） */
export interface GroupEssenceWire {
  id: string;
  msgSeq: number;
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
  senderTime?: string;
  canRemove?: boolean;
}

export function GroupEssenceDialog({
  groupCode: _groupCode,
  groupName,
  essenceMessages,
  loading,
  onClose,
  onJumpToMessage,
}: {
  groupCode: string;
  groupName: string;
  essenceMessages?: GroupEssenceWire[];
  /** 是否正在拉取（数据库 / 联网） — 首次打开时避免闪现“暂无群精华”。 */
  loading?: boolean;
  onClose: () => void;
  onJumpToMessage?: (seq: number) => void;
}): ReactElement {
  useEscapeToClose(onClose);

  return (
    <div className="modal-scrim group-essence-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section className="group-essence-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
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
          {loading && (!essenceMessages || essenceMessages.length === 0) ? (
            <div className="group-essence-empty is-loading">
              <RefreshCw size={22} className="weq-gap-spin" />
              <span>正在拉取群精华…</span>
            </div>
          ) : essenceMessages && essenceMessages.length > 0 ? (
            <div className="group-essence-list">
              {essenceMessages.map((item) => {
                const canJump = onJumpToMessage && item.msgSeq != null && item.msgSeq !== '';
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`group-essence-item${canJump ? ' is-clickable' : ''}`}
                    onClick={() => {
                      if (canJump) {
                        onClose();
                        onJumpToMessage(item.msgSeq);
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
                                  {element.fileSize ? ` (${formatFileSize(element.fileSize)})` : ''}
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
                );
              })}
            </div>
          ) : (
            <div className="group-essence-empty">
              <Sparkles size={22} />
              <span>暂无群精华</span>
              <small>本地与联网都没有找到，去 QQ 群里把消息设为精华后再来看看</small>
            </div>
          )}
        </div>
      </section>
    </div>
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
