import type { ReactNode } from 'react';
import { isRemoteClient } from '../lib/remoteClient';
import { ChatHeader } from './ChatHeader';
import { ContentErrorBoundary } from './ContentErrorBoundary';
import { EmptyState } from './EmptyState';

export function ConversationRenderBoundary({
  children,
  resetKey,
  onBack,
}: {
  children: ReactNode;
  resetKey: string;
  onBack: () => void;
}) {
  if (!isRemoteClient()) return children;
  return (
    <ContentErrorBoundary
      resetKey={resetKey}
      fallback={(retry) => (
        <section className="chat-pane">
          <ChatHeader title="会话" onBack={onBack} actions={null} />
          <EmptyState
            role="status"
            title="暂时无法显示这段会话"
            body={
              <button type="button" className="weq-set-btn" onClick={retry}>
                重试
              </button>
            }
          />
        </section>
      )}
    >
      {children}
    </ContentErrorBoundary>
  );
}
