import type { ReactNode } from 'react';
import '../styles/message-selection-toolbar.css';

/** 会话、消息与资源共用多选计数和操作栏外壳，具体动作由宿主提供。 */
export function MessageSelectionBar({
  count,
  detail,
  children,
  unit = '条',
  subject = '消息',
}: {
  count: number;
  detail?: ReactNode;
  children?: ReactNode;
  unit?: string;
  subject?: string;
}) {
  return (
    <div className="selection-bar" role="toolbar" aria-label={`${subject}多选操作`}>
      <div
        className="selection-bar-info"
        aria-label={`已选 ${count} ${unit}${subject}`}
        aria-live="polite"
      >
        <span className="selection-bar-count">{count}</span>
        <span className="selection-bar-label">{unit}已选</span>
        {detail}
      </div>
      <div className="selection-bar-actions">{children}</div>
    </div>
  );
}
