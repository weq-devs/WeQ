import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SelfProfileDialog } from '../../src/renderer/src/im-template/template/TitleBar';
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
              {surface === 'profile' && <SelfProfileDialog onClose={noop} />}
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
