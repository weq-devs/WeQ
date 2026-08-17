// @ts-nocheck
import type { ReactElement } from 'react';
import { X } from 'lucide-react';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';
import { Avatar } from '../im-template/template/primitives';
import { albumMediaUrl } from '../lib/resourceUrl';

export interface GroupBulletinImage {
  id: string;
  width: number;
  height: number;
}

export interface GroupBulletinWire {
  fid: string;
  publisherUid: string;
  textContent: string;
  ctime: string;
  msgTime: string;
  publisherName?: string;
  publisherAvatar?: string;
  images?: GroupBulletinImage[];
  readNum?: number;
}

export function GroupAnnouncementsDialog({
  groupCode: _groupCode,
  groupName,
  currentAnnouncement,
  bulletins,
  onClose,
}: {
  groupCode: string;
  groupName: string;
  currentAnnouncement?: string | null;
  bulletins?: GroupBulletinWire[];
  onClose: () => void;
}): ReactElement {
  useEscapeToClose(onClose);

  return (
    <div className="modal-scrim group-announcements-scrim" role="presentation" onMouseDown={closeFromScrim(onClose)}>
      <section className="group-announcements-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <div>
            <strong>群公告</strong>
            <span>{groupName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="group-announcements-body">
          {currentAnnouncement?.trim() ? (
            <article className="group-bulletin-item is-current">
              <header className="group-bulletin-header">
                <span className="group-bulletin-label">当前公告</span>
              </header>
              <div className="group-bulletin-content">
                <p>{currentAnnouncement}</p>
              </div>
            </article>
          ) : null}

          {bulletins && bulletins.length > 0 ? (
            <div className="group-bulletins-list">
              <div className="group-bulletins-list-header">历史公告</div>
              {bulletins.map((bulletin) => {
                const decodedText = decodeHtmlEntities(bulletin.textContent);
                return (
                  <article key={bulletin.fid} className="group-bulletin-item">
                    <div className="group-bulletin-layout">
                      <Avatar
                        name={bulletin.publisherName || bulletin.publisherUid || '未知'}
                        avatarUrl={bulletin.publisherAvatar}
                        seed={bulletin.publisherUid}
                      />
                      <div className="group-bulletin-main">
                        <div className="group-bulletin-header">
                          <span className="group-bulletin-publisher-name">
                            {bulletin.publisherName || `用户 ${bulletin.publisherUid || '未知'}`}
                          </span>
                          <span className="group-bulletin-date">
                            {formatShortDate(bulletin.ctime || bulletin.msgTime)}
                            {bulletin.readNum !== undefined && bulletin.readNum > 0 && (
                              <> · {bulletin.readNum} 人已确认</>
                            )}
                          </span>
                        </div>
                        <div className="group-bulletin-content">
                          <p>{decodedText}</p>
                          {bulletin.images && bulletin.images.length > 0 && (
                            <div className="group-bulletin-images">
                              {bulletin.images.map((img) => (
                                <img
                                  key={img.id}
                                  src={albumMediaUrl(
                                    `https://gdynamic.qpic.cn/gdynamic/${img.id}/628`,
                                  )}
                                  alt="公告图片"
                                  loading="lazy"
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}

          {!currentAnnouncement && (!bulletins || bulletins.length === 0) ? (
            <div className="group-announcements-empty">暂无群公告</div>
          ) : null}
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

function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}
