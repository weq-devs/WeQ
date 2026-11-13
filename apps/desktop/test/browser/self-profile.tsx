import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { qa, trpc } from './self-profile.stub';
import { qa as displayQa } from './profile-display.stub';
import { ContactProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { useViewState } from '../../src/renderer/src/state/view';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

Object.assign(window, { selfProfileQa: qa, profileDisplayQa: displayQa });
useViewState.setState({ openedUin: '10001' });
const directory = {
  selfUin: '10001',
  selfUid: 'u_self',
  friends: new Map(),
  friendsComplete: true,
  groups: new Map(),
};
function Fixture() {
  const { data } = trpc.account.getSelfProfile.useQuery();
  const params = new URLSearchParams(location.search);
  return (
    <main
      className="weq-self-profile-page"
      style={{ height: '100%', maxWidth: 1180, margin: '0 auto' }}
    >
      <ContactProfileDialog
        embedded={!params.has('popover')}
        onClose={() => {}}
        contact={{
          ...data,
          id: params.has('other') ? 'u_other' : 'u_self',
          uid: params.has('other') ? 'u_other' : 'u_self',
          username: data.nick,
          identityLabel: 'QQ',
          identityValue: params.has('other') ? '10002' : data.uin,
          displayName: data.nick,
          avatarUrl: '/_avatar/synthetic',
          createdAt: '',
        }}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <RelationshipDirectoryContext.Provider value={directory}>
      <style>{'html,body,#root{height:100%;margin:0}'}</style>
      <Fixture />
    </RelationshipDirectoryContext.Provider>
  </QueryClientProvider>,
);
