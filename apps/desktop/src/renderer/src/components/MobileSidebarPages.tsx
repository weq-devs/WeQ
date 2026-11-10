import { useEffect, useState, type ReactNode } from 'react';
import type { MainView } from '../im-template/template/types';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { preloadMobilePages } from '../lib/mobilePageLoading';
import { RetainedTabs } from './RetainedTabs';

/** 手机常用列表在空闲时预渲染，切页时复用节点；桌面仍只挂载当前列表。 */
export function MobileSidebarPages({
  activeKey,
  renderPage,
}: {
  activeKey: MainView;
  renderPage: (view: MainView) => ReactNode;
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
  const keys: MainView[] = mobile
    ? [...new Set<MainView>([...(warm ? (['messages', 'contacts'] as const) : []), activeKey])]
    : [activeKey];
  return keys.map((key) => (
    <div
      key={key}
      hidden={key !== activeKey}
      data-mobile-sidebar-active={key === activeKey}
      data-mobile-sidebar-page={key}
      style={{
        display: key === activeKey ? 'flex' : 'none',
        flex: 1,
        height: '100%',
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <RetainedTabs snapshotKey="sidebar" activeKey={key} scrollable>
        {renderPage(key)}
      </RetainedTabs>
    </div>
  ));
}
