import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import '../styles/empty-state.css';

/** 列表与面板共用的空态；紧凑容器不占满整页。 */
export function EmptyState({
  title,
  body,
  icon = <Inbox />,
  compact = false,
}: {
  title: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`weq-empty-state${compact ? ' is-compact' : ''}`}>
      <div className="weq-empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="weq-empty-state-title">{title}</div>
      {body ? <div className="weq-empty-state-body">{body}</div> : null}
    </div>
  );
}
