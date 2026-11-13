import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SelfProfileFixture as SelfQQControls } from '../support/SelfProfileFixture';
import { QQExactLookup } from '../../src/renderer/src/components/QQExactLookup';
import { CollectionDialog } from '../../src/renderer/src/components/CollectionDialog';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import { MailWorkspace } from '../../src/renderer/src/views/MailView';
import { ChannelView } from '../../src/renderer/src/views/ChannelView';
import { QzoneView } from '../../src/renderer/src/views/QzoneView';
import { PageSnapshotScope } from '../../src/renderer/src/components/PageSnapshots';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { useViewState } from '../../src/renderer/src/state/view';
import { MobileWebNavigation } from '../../src/renderer/src/components/MobileWebNavigation';
import { subscribeResponsiveLayout } from '../../src/renderer/src/lib/responsiveLayout';
import { MobileNavigationRuntime } from '../../src/renderer/src/components/MobileNavigationRuntime';
import type { MainView } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';

const noop = () => {};
const user = {
  id: 'fixture',
  uid: 'u_fixture',
  username: 'fixture',
  displayName: '合成昵称',
  identityLabel: 'QQ',
  identityValue: '10001',
  avatarUrl: null,
};
/**
 * headless 的 `screen.orientation` 不会跟着视口走（320×844 竖屏下也可能报
 * landscape-primary），移动端会被误判成多栏、退回桌面 inset，制造假阳性。
 * 这里按实际视口同步方向，并在 resize 时派发 change，让布局判断拿到真值。
 */
const qaOrientation = Object.assign(new EventTarget(), { type: 'portrait-primary' });
Object.defineProperty(screen, 'orientation', { configurable: true, value: qaOrientation });
function syncOrientation(): void {
  const type = innerWidth > innerHeight ? 'landscape-primary' : 'portrait-primary';
  if (qaOrientation.type === type) return;
  qaOrientation.type = type;
  qaOrientation.dispatchEvent(new Event('change'));
}
syncOrientation();
// 布局模块在 import 阶段用的是当时的 orientation（那时上面这次同步还没跑），
// 而这个 fixture 默认不渲染任何会订阅布局的组件，所以必须主动重算一次；
// subscribeResponsiveLayout 会立刻跑一次 update 并保留后续 resize 的监听。
subscribeResponsiveLayout(() => {});
window.addEventListener('resize', syncOrientation);

ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
function Fixture() {
  const [surface, setSurface] = useState('profile');
  const [refresh, setRefresh] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const navigation = new URLSearchParams(location.search).has('navigation');
  const view: MainView = surface === 'channel-direct' ? 'guild-direct' : 'mail';
  Object.assign(window, {
    mobileSurfacesQa: {
      show: setSurface,
      refresh: () => setRefresh((value) => value + 1),
      theme: useThemeStore,
    },
  });
  return (
    <>
      <style>{`html,body,#root{height:100%;margin:0}.fixture-page{height:100%;min-width:0;overflow:auto;background:var(--weq-bg-surface);color:var(--weq-fg-primary)}`}</style>
      <div ref={root} className="app-shell-root weq-web-shell" data-mobile-workspace>
        {navigation && (
          <>
            <MobileNavigationRuntime root={root} />
            <MobileWebNavigation
              user={user}
              view={view}
              hidden={false}
              query=""
              onQueryChange={noop}
              messageBadgeCount={refresh}
              contactBadgeCount={0}
              onViewChange={() => {}}
              onOpenSettings={noop}
              onOpenDressUp={noop}
              onOpenCollection={noop}
            />
          </>
        )}
        <div
          className={navigation ? 'app-shell' : undefined}
          style={navigation ? undefined : { display: 'contents' }}
        >
          <main className={`fixture-page${navigation ? ' chat-main' : ''}`} data-surface={surface}>
            <PageSnapshotScope key={surface} name={`mobile-qa:${surface}`}>
              {surface === 'profile' && (
                <section className="weq-self-profile-page">
                  <SelfQQControls editable={false} />
                </section>
              )}
              {surface === 'lookup' && <QQExactLookup kind="user" onClose={noop} />}
              {surface === 'collections' && <CollectionDialog open embedded onClose={noop} />}
              {surface === 'mail' && <MailWorkspace active selfUin="10001" onUnreadChange={noop} />}
              {(surface === 'channel' || surface === 'channel-direct') && (
                <ChannelView selfUser={user} initialDirectOpen={surface === 'channel-direct'} />
              )}
              {surface === 'qzone' && <QzoneView selfUin="10001" nickname="合成昵称" />}
              {surface.startsWith('settings') && (
                <SettingsDialog
                  open
                  onClose={noop}
                  onOpenMaintenance={noop}
                  onOpenRecalls={noop}
                  initialSection={
                    surface === 'settings-appearance'
                      ? 'appearance'
                      : surface === 'settings-account'
                        ? 'account'
                        : surface === 'settings-display'
                          ? 'message-display'
                          : undefined
                  }
                />
              )}
            </PageSnapshotScope>
          </main>
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
