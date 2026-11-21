import type { ReactNode, Ref } from 'react';
import { QzonePersonButton, QzoneProfileAvatar } from './QzoneProfileAvatar';
import { QqAvatar } from './QqAvatar';
import { QzoneInlineText } from './QzoneEmoji';
import { QzoneTime } from './QzoneTime';

export function QzoneCommentRow({
  uin,
  nickname,
  time,
  onSpace,
  name,
  inline,
  actions,
  afterMeta,
  className,
  rowRef,
  children,
}: {
  uin: string;
  nickname: string;
  time: number | string;
  onSpace: (uin: string, nickname?: string) => void;
  name?: ReactNode;
  inline?: ReactNode;
  actions?: ReactNode;
  afterMeta?: ReactNode;
  className?: string;
  rowRef?: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  const label = name ?? (
    <span className="weq-qzn-name" data-privacy-sensitive={Boolean(nickname || uin) || undefined}>
      <QzoneInlineText content={nickname || uin || '空间用户'} />
    </span>
  );
  return (
    <div className={className ? `weq-qzn-comment ${className}` : 'weq-qzn-comment'} ref={rowRef}>
      {uin ? (
        <QzoneProfileAvatar size={26} uin={uin} nickname={nickname} onSpace={onSpace} />
      ) : (
        <QqAvatar uin={null} size={26} />
      )}
      <div>
        <div className="weq-qzn-comment-line">
          {uin ? (
            <QzonePersonButton uin={uin} nickname={nickname} onSpace={onSpace}>
              {label}
            </QzonePersonButton>
          ) : (
            label
          )}
          {inline}
        </div>
        {children}
        {time || actions ? (
          <div className="weq-qzn-comment-meta">
            <QzoneTime value={time} />
            {actions}
          </div>
        ) : null}
        {afterMeta}
      </div>
    </div>
  );
}
