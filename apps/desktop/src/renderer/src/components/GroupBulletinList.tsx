import { useRef, type ReactNode, type MouseEvent } from 'react';
import { useSearchTargetFocus } from '../hooks/useSearchTargetFocus';
import { Avatar } from '../im-template/template/primitives';
import { albumMediaUrl } from '../lib/resourceUrl';
import type { GroupNoticeEntry } from '../lib/groupNotices';
import { ProfileAvatar } from './ProfileAvatar';

export function GroupBulletinList({
  entries,
  groupCode,
  groupName,
  tools,
  onContextMenu,
  initialNoticeId,
}: {
  entries: GroupNoticeEntry[];
  groupCode: string;
  groupName: string;
  tools: (entry: GroupNoticeEntry) => ReactNode;
  onContextMenu: (event: MouseEvent, entry: GroupNoticeEntry) => void;
  initialNoticeId?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useSearchTargetFocus(root, 'data-notice-id', initialNoticeId, entries.length > 0);
  return (
    <div ref={root} className="group-bulletins-list">
      {entries.map((entry) => (
        <article
          key={entry.key}
          className="group-bulletin-item"
          data-notice-key={entry.key}
          data-notice-id={entry.noticeId}
          onContextMenu={(event) => onContextMenu(event, entry)}
        >
          <div className="group-bulletin-layout">
            <ProfileAvatar
              className="weq-identity-link group-bulletin-author"
              target={{
                identity: entry.publisherUid,
                uin: entry.publisherUin,
                name: entry.publisherName || entry.publisherUid,
                avatarUrl: entry.publisherAvatar,
                group: { code: groupCode, name: groupName },
              }}
            >
              <Avatar
                name={entry.publisherName || entry.publisherUid || '未知'}
                avatarUrl={entry.publisherAvatar}
                seed={entry.publisherUid}
              />
              <span className="group-bulletin-publisher-name">
                {entry.publisherName || `用户 ${entry.publisherUid || '未知'}`}
              </span>
            </ProfileAvatar>
            <div className="group-bulletin-main">
              <div className="group-bulletin-header">
                <span className="group-bulletin-date">
                  {entry.date && <span>{entry.date}</span>}
                  {entry.readNum !== undefined && <span>{entry.readNum} 人已读</span>}
                  {!entry.noticeId && <span>历史记录</span>}
                </span>
                {tools(entry)}
              </div>
              <div className="group-bulletin-content">
                <p>{entry.text}</p>
                {entry.images.length > 0 && (
                  <div className="group-bulletin-images">
                    {entry.images.map((image) => (
                      <img
                        key={image.id}
                        src={albumMediaUrl(`https://gdynamic.qpic.cn/gdynamic/${image.id}/628`)}
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
      ))}
    </div>
  );
}
