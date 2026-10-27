import type { ReactNode } from 'react';
import '../styles/message-selection-toolbar.css';

/** 普通会话与克隆会话共用多选计数和操作栏外壳，具体动作由宿主提供。 */
export function MessageSelectionBar({
  count,
  detail,
  children,
}: {
  count: number;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="selection-bar" role="toolbar" aria-label="消息多选操作">
      <div className="selection-bar-info" aria-label={`已选 ${count} 条消息`} aria-live="polite">
        <span className="selection-bar-count">{count}</span>
        <span className="selection-bar-label">条已选</span>
        {detail}
      </div>
      <div className="selection-bar-actions">{children}</div>
    </div>
  );
}
