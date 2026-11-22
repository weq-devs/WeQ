import type { ReactNode, Ref } from 'react';
import { QzoneName, QzonePersonButton, QzoneProfileAvatar } from './QzoneProfileAvatar';
import { QqAvatar } from './QqAvatar';
import { QzoneTime } from './QzoneTime';

export function QzoneCommentRow({
  uin,
  nickname,
  time,
  onSpace,
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
  inline?: ReactNode;
  actions?: ReactNode;
  afterMeta?: ReactNode;
  className?: string;
  rowRef?: Ref<HTMLDivElement>;
  children?: ReactNode;
}) {
  const label = <QzoneName content={nickname || '空间用户'} uin={uin} />;
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
