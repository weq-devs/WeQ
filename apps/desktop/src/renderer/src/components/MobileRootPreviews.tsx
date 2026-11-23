import type { ReactNode } from 'react';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import type { MainView } from '../im-template/template/types';

export function MobileRootPreviews({
  renderHeader,
}: {
  renderHeader: (view: MainView) => ReactNode;
}) {
  const mobile = useMobileWebLayout();
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
    </div>
  );
}
