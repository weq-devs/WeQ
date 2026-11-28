import { ProfileChatShortcutContext } from '../lib/chatNavigation';
import { activateProfile } from '../lib/profileClick';
import { useContext, useEffect, type ReactNode, type CSSProperties } from 'react';
import { QzoneProfileContext, QzonePersonContext } from '../lib/qzoneNavigation';
import { profileTargetUser } from '../lib/profileNavigation';
import { qzonePlainText } from '../lib/qzone';
import { QzonePeopleContext, qzoneDisplayName } from '../lib/qzonePeople';
import { QqAvatar } from './QqAvatar';
import { QzoneInlineText } from './QzoneEmoji';
import '../styles/identity-links.css';

export function QzoneName({ content, uin }: { content: string; uin?: string | null }) {
  const { namePriority, nickname, remark, request } = useContext(QzonePeopleContext);
  const nick = uin ? nickname(uin, content) : '';
  const alias = uin ? remark(uin) : '';
  useEffect(() => {
    if (uin && !nick && (!alias || namePriority === 'nickname')) request(uin);
  }, [uin, nick, alias, namePriority, request]);
  const title = qzonePlainText(nick);
  return (
    <span
      className="weq-qzn-name"
      title={uin ? (title ? `${title} (${uin})` : `QQ ${uin}`) : undefined}
      onMouseEnter={() => {
        if (uin && !nick) request(uin);
      }}
    >
      <QzoneInlineText content={uin ? qzoneDisplayName(uin, nick, alias, namePriority) : content} />
    </span>
  );
}

/** 昵称与头像共用设置，当前空间主人始终打开名片。 */
export function QzonePersonButton({
  uin,
  nickname,
  onSpace,
  children,
  className,
  style,
}: {
  uin: string;
  nickname?: string;
  onSpace?: (uin: string, nickname?: string) => void;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const openProfile = useContext(QzoneProfileContext);
  const chatShortcut = useContext(ProfileChatShortcutContext);
  const context = useContext(QzonePersonContext);
  const people = useContext(QzonePeopleContext);
  const showProfile = context.spaceUin === uin || context.action === 'profile';
  const openSpace = onSpace ?? context.onSpace;
  const nick = people.nickname(uin, nickname);
  const label = qzonePlainText(
    qzoneDisplayName(uin, nick, people.remark(uin), people.namePriority),
  );
  return (
    <button
      type="button"
      className={`weq-qzn-person-link${className ? ` ${className}` : ''}`}
      style={style}
      aria-label={showProfile ? `查看 ${label} 的资料` : `进入 ${label} 的空间`}
      disabled={showProfile ? !openProfile : !openSpace}
      data-weq-force-click={showProfile ? 'profile' : undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (showProfile) {
          const rect = event.currentTarget.getBoundingClientRect();
          const anchor =
            event.detail === 0
              ? { x: rect.right, y: rect.bottom, trigger: event.currentTarget }
              : { x: event.clientX, y: event.clientY, trigger: event.currentTarget };
          const user = profileTargetUser({ identity: uin, name: nick || uin });
          activateProfile(
            event,
            () => openProfile?.(uin, nick || uin, anchor),
            user && chatShortcut ? chatShortcut({ kind: 'direct', user }) : undefined,
          );
        } else openSpace?.(uin, nick || nickname);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
      }}
    >
      {children}
    </button>
  );
}

/** 头像与昵称同路由，昵称和时间作为一组与头像垂直居中。 */
export function QzonePersonHeader({
  uin,
  nickname,
  url,
  size,
  onSpace,
  children,
  time,
}: {
  uin?: string | null;
  nickname: string;
  url?: string | null;
  size: number;
  onSpace?: (uin: string, nickname?: string) => void;
  children?: ReactNode;
  time?: ReactNode;
}) {
  return (
    <div className="weq-qzn-person-header">
      {uin ? (
        <QzoneProfileAvatar uin={uin} nickname={nickname} url={url} size={size} onSpace={onSpace} />
      ) : (
        <QqAvatar uin={null} url={url} size={size} />
      )}
      <div className="weq-qzn-person-info">
        {uin ? (
          <QzonePersonButton uin={uin} nickname={nickname} onSpace={onSpace}>
            {children ?? <QzoneName content={nickname} uin={uin} />}
          </QzonePersonButton>
        ) : (
          <span className="weq-qzn-name">{children ?? <QzoneInlineText content={nickname} />}</span>
        )}
        {time}
      </div>
    </div>
  );
}

export function QzonePersonIdentity({
  uin,
  nickname,
  url,
  size,
  className = '',
  onSpace,
  children,
}: {
  uin: string;
  nickname?: string;
  url?: string | null;
  size: number;
  className?: string;
  onSpace?: (uin: string, nickname?: string) => void;
  children?: ReactNode;
}) {
  return (
    <QzonePersonButton
      uin={uin}
      nickname={nickname}
      onSpace={onSpace}
      className={`weq-qzn-identity-link ${className}`}
    >
      <QqAvatar uin={uin} url={url} size={size} />
      {children ?? <QzoneName content={nickname || uin} uin={uin} />}
    </QzonePersonButton>
  );
}

export function QzoneProfileAvatar({
  uin,
  nickname,
  url,
  size,
  className,
  onSpace,
}: {
  uin: string;
  nickname?: string;
  url?: string | null;
  size: number;
  className?: string;
  onSpace?: (uin: string, nickname?: string) => void;
}) {
  return (
    <QzonePersonButton
      uin={uin}
      nickname={nickname}
      onSpace={onSpace}
      className={`weq-qzn-profile-avatar${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
    >
      <QqAvatar uin={uin} url={url} size={size} />
    </QzonePersonButton>
  );
}
