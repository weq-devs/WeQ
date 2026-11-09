import { useEffect, useState, type ReactNode } from 'react';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import type { MainView, User } from '../im-template/template/types';
import { QzoneWorkspace } from './lazyWorkspaces';
import { preloadMobilePages } from '../lib/mobilePageLoading';

export function MobileRootPreviews({
  user,
  renderHeader,
}: {
  user: User;
  renderHeader: (view: MainView) => ReactNode;
}) {
  const mobile = useMobileWebLayout();
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (!mobile) return undefined;
    return preloadMobilePages([
      async () => {
        setWarm(true);
      },
    ]);
  }, [mobile]);
  if (!mobile) return null;
  return (
    <div hidden inert aria-hidden="true">
      {(['messages', 'contacts'] as const).map((view) => (
        <div key={view} data-mobile-root-preview={view}>
          <aside className="sidebar">
            {renderHeader(view)}
            <div className="sidebar-body" />
          </aside>
        </div>
      ))}
      <div data-mobile-root-preview="qzone">
        <main className="chat-main">
          {warm && (
            <QzoneWorkspace
              active={false}
              previewOnly
              selfUin={user.identityValue}
              nickname={user.displayName}
            />
          )}
        </main>
      </div>
    </div>
  );
}
