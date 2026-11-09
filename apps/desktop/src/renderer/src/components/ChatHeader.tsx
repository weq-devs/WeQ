import type { ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';

/** 真实与本地克隆会话共用标题栏，能力入口由各自宿主提供。 */
export function ChatHeader({
  title,
  status,
  mobileStatus,
  actions,
  onBack,
}: {
  title: ReactNode;
  status?: ReactNode;
  mobileStatus?: ReactNode;
  actions: ReactNode;
  onBack: () => void;
}) {
  return (
    <header className="chat-header">
      <button
        type="button"
        className="icon-button back-button"
        onClick={onBack}
        title="返回"
        aria-label="返回会话列表"
      >
        <ChevronLeft size={22} />
      </button>
      <div className="chat-title">
        <strong>{title}</strong>
        {mobileStatus ? (
          <>
            <span className="chat-status-desktop">{status}</span>
            <span className="chat-status-mobile">{mobileStatus}</span>
          </>
        ) : (
          status
        )}
      </div>
      <div className="chat-actions" role="toolbar" aria-label="会话工具栏">
        {actions}
      </div>
    </header>
  );
}
