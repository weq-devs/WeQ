// @ts-nocheck
import { useId, useState, type ReactElement } from 'react';
import { ListTodo, Megaphone, X } from 'lucide-react';
import { OverlayLayer } from './OverlayLayer';
import { Avatar } from '../im-template/template/primitives';
import { albumMediaUrl } from '../lib/resourceUrl';
import { GroupNoticeActions } from './qq-actions/GroupNoticeActions';
import { ProfileAvatar } from './ProfileAvatar';
import { GroupTodos } from './qq-actions/GroupActions';
import '../styles/group-announcements.css';

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
  groupCode,
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
  const [tab, setTab] = useState<'announcements' | 'todos'>('announcements');
  const id = useId();
  const tabs = [
    { id: 'announcements', label: '群公告', icon: Megaphone },
    { id: 'todos', label: '群待办', icon: ListTodo },
  ] as const;
  return (
    <OverlayLayer
      presentation="sidecar"
      title="公告与待办"
      className="modal-scrim group-announcements-scrim"
      onClose={onClose}
    >
      <section
        className="group-announcements-dialog"
        role="dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <strong>公告与待办</strong>
            <span>{groupName}</span>
          </div>
          <button className="icon-button" type="button" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="weq-group-notice-tabs" role="tablist" aria-label="群公告与待办">
          {tabs.map((item, index) => (
            <button
              key={item.id}
              id={`${id}-${item.id}`}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              aria-controls={`${id}-panel`}
              tabIndex={tab === item.id ? 0 : -1}
              onClick={() => setTab(item.id)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? tabs.length - 1
                      : event.key === 'ArrowLeft'
                        ? (index + tabs.length - 1) % tabs.length
                        : event.key === 'ArrowRight'
                          ? (index + 1) % tabs.length
                          : null;
                if (next === null) return;
                event.preventDefault();
                setTab(tabs[next].id);
                event.currentTarget.parentElement
                  ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
                  [next]?.focus();
              }}
            >
              <item.icon size={15} aria-hidden />
              {item.label}
            </button>
          ))}
        </div>
        <div
          className="group-announcements-body"
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-${tab}`}
          tabIndex={0}
        >
          {tab === 'todos' ? (
            <GroupTodos key={groupCode} groupId={Number(groupCode)} embedded />
          ) : (
            <>
              <GroupNoticeActions key={groupCode} groupId={Number(groupCode)} />
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
                          <ProfileAvatar
                            target={{
                              identity: bulletin.publisherUid,
                              name: bulletin.publisherName || bulletin.publisherUid,
                              avatarUrl: bulletin.publisherAvatar,
                              group: { code: groupCode, name: groupName },
                            }}
                          >
                            <Avatar
                              name={bulletin.publisherName || bulletin.publisherUid || '未知'}
                              avatarUrl={bulletin.publisherAvatar}
                              seed={bulletin.publisherUid}
                            />
                          </ProfileAvatar>
                          <div className="group-bulletin-main">
                            <div className="group-bulletin-header">
                              <span className="group-bulletin-publisher-name">
                                {bulletin.publisherName ||
                                  `用户 ${bulletin.publisherUid || '未知'}`}
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
            </>
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

function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}
