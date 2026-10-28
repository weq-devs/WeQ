import { useContext, type ReactNode, type CSSProperties } from 'react';
import { QzoneProfileContext, QzonePersonContext } from '../lib/qzoneNavigation';
import { QqAvatar } from './QqAvatar';

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
      className={className}
      style={style}
      aria-label={showProfile ? `查看 ${nickname || uin} 的资料` : `进入 ${nickname || uin} 的空间`}
      disabled={showProfile ? !openProfile : !openSpace}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (showProfile)
          openProfile?.(uin, nickname || uin, { x: event.clientX, y: event.clientY });
        else openSpace?.(uin, nickname);
      }}
    >
      {children}
    </button>
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
