import { useContext, type ReactNode, type CSSProperties } from 'react';
import { QzoneProfileContext, QzonePersonContext } from '../lib/qzoneNavigation';
import { QqAvatar } from './QqAvatar';
import '../styles/identity-links.css';

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
  const context = useContext(QzonePersonContext);
  const showProfile = context.spaceUin === uin || context.action === 'profile';
  const openSpace = onSpace ?? context.onSpace;
  return (
    <button
      type="button"
      className={`weq-qzn-person-link${className ? ` ${className}` : ''}`}
      style={style}
      aria-label={showProfile ? `查看 ${nickname || uin} 的资料` : `进入 ${nickname || uin} 的空间`}
      disabled={showProfile ? !openProfile : !openSpace}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (showProfile) {
          const rect = event.currentTarget.getBoundingClientRect();
          openProfile?.(
            uin,
            nickname || uin,
            event.detail === 0
              ? { x: rect.right, y: rect.bottom }
              : { x: event.clientX, y: event.clientY },
          );
        } else openSpace?.(uin, nickname);
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
            {children ?? <span className="weq-qzn-name">{nickname}</span>}
          </QzonePersonButton>
        ) : (
          <span className="weq-qzn-name">{children ?? nickname}</span>
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
      {children ?? <span className="weq-qzn-name">{nickname || uin}</span>}
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
