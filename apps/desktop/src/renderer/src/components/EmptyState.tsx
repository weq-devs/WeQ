import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import '../styles/empty-state.css';

/** 列表与面板共用的空态；紧凑容器不占满整页。 */
export function EmptyState({
  title,
  body,
  icon = <Inbox />,
  compact = false,
  variant = compact ? 'compact' : 'panel',
  role,
}: {
  title: ReactNode;
  body?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  variant?: 'panel' | 'compact' | 'inline';
  role?: 'status';
}) {
  return (
    <div className={`weq-empty-state is-${variant}`} role={role}>
      <div className="weq-empty-state-icon" aria-hidden="true">
        {icon}
      </div>
      <div className="weq-empty-state-copy">
        <div className="weq-empty-state-title">{title}</div>
        {body ? <div className="weq-empty-state-body">{body}</div> : null}
      </div>
    </div>
  );
}
