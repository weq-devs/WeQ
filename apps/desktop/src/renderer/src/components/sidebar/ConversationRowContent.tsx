import type { ReactNode } from 'react';

export function ConversationRowContent({
  title,
  time,
  preview,
  status,
}: {
  title: ReactNode;
  time: ReactNode;
  preview: ReactNode;
  status: ReactNode;
}) {
  const twoLines = preview != null;

  return (
    <span className="row-main weq-conversation-row-content">
      <span className="weq-conversation-row-line">
        <strong>{title}</strong>
        <span className="row-meta">
          {twoLines ? null : status}
          <span className="row-time-line">{time}</span>
        </span>
      </span>
      {twoLines ? (
        <span className="weq-conversation-row-line">
          <span className="row-preview-line">{preview}</span>
          {status}
        </span>
      ) : null}
    </span>
  );
}
