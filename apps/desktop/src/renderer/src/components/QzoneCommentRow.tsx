import type { ReactNode, Ref } from 'react';
import { QzonePersonButton, QzoneProfileAvatar } from './QzoneProfileAvatar';
import { QqAvatar } from './QqAvatar';
import { QzoneInlineText } from './QzoneEmoji';
import { timeText } from '../views/qzoneShared.shared';

export function QzoneCommentRow({
  uin,
  nickname,
  time,
  onSpace,
  name,
  reply,
  actions,
  afterMeta,
  className,
  rowRef,
  children,
}: {
  uin: string;
  nickname: string;
  time: number | string | null;
  onSpace: (uin: string, nickname?: string) => void;
  name?: ReactNode;
  reply?: { recipient?: ReactNode; content: ReactNode };
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
    <div
      className={`weq-qzn-comment${reply ? ' is-reply' : ''}${className ? ` ${className}` : ''}`}
      ref={rowRef}
    >
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
          {reply ? (
            <>
              <span> 回复{reply.recipient ? <> {reply.recipient}</> : null}：</span>
              <span className="weq-qzn-reply-message">{reply.content}</span>
            </>
          ) : null}
        </div>
        {children}
        {time || actions ? (
          <div className="weq-qzn-comment-meta">
            <time>{typeof time === 'string' ? time : timeText(time ?? 0)}</time>
            {actions}
          </div>
        ) : null}
        {afterMeta}
      </div>
    </div>
  );
}
