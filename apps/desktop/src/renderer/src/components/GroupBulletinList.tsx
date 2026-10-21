import type { ReactNode, MouseEvent } from 'react';
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
}: {
  entries: GroupNoticeEntry[];
  groupCode: string;
  groupName: string;
  tools: (entry: GroupNoticeEntry) => ReactNode;
  onContextMenu: (event: MouseEvent, entry: GroupNoticeEntry) => void;
}) {
  return (
    <div className="group-bulletins-list">
      {entries.map((entry) => (
        <article
          key={entry.key}
          className="group-bulletin-item"
          data-notice-key={entry.key}
          onContextMenu={(event) => onContextMenu(event, entry)}
        >
          <div className="group-bulletin-layout">
            <ProfileAvatar
              target={{
                identity: entry.publisherUid,
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
            </ProfileAvatar>
            <div className="group-bulletin-main">
              <div className="group-bulletin-header">
                <span className="group-bulletin-publisher-name">
                  {entry.publisherName || `用户 ${entry.publisherUid || '未知'}`}
                </span>
                <span className="group-bulletin-date">
                  {entry.date}
                  {entry.readNum !== undefined && <> · {entry.readNum} 人已读</>}
                  {!entry.noticeId && ' · 本地记录'}
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
