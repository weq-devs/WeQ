import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QQExactLookup } from '../../src/renderer/src/components/QQExactLookup';
import { GroupAlbumManagement } from '../../src/renderer/src/components/qq-actions/GroupAlbumManagement';
import { FriendDirectoryControls } from '../../src/renderer/src/components/FriendDirectoryControls';
import { useFriendDirectory } from '../../src/renderer/src/components/FriendDirectoryControls.shared';
import { useViewState } from '../../src/renderer/src/state/view';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { subscribeResponsiveLayout } from '../../src/renderer/src/lib/responsiveLayout';
import { qa } from './compact-dialogs.stub';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/lib/inputModality';

const noop = () => {};
const queryClient = new QueryClient();
ensureThemeInitialized();
useViewState.setState({ openedUin: '10001' });
subscribeResponsiveLayout(noop);
function DirectoryEditor({ mode }: { mode: string }) {
  const { move, edit, create } = useFriendDirectory()!;
  useEffect(() => {
    if (mode === 'move') move(['u_fixture']);
    else if (mode === 'delete') edit('delete', 1);
    else create();
  }, [mode, move, edit, create]);
  return null;
}
function Fixture() {
  const [surface, setSurface] = useState('user');
  Object.assign(window, { compactDialogsQa: { show: setSurface, theme: useThemeStore, ...qa } });
  return (
    <main style={{ height: '100dvh', background: 'var(--weq-chat-bg)' }}>
      {surface === 'closed' ? (
        <p>已关闭</p>
      ) : surface === 'user' || surface === 'group' ? (
        <QQExactLookup key={surface} kind={surface} onClose={() => setSurface('closed')} />
      ) : surface === 'album' ? (
        <GroupAlbumManagement groupCode="12345" onChanged={noop} />
      ) : (
        <FriendDirectoryControls key={surface}>
          <DirectoryEditor mode={surface} />
        </FriendDirectoryControls>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
);
