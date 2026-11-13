import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { qa, trpc } from './self-profile.stub';
import { qa as displayQa } from './profile-display.stub';
import { ContactProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { useViewState } from '../../src/renderer/src/state/view';
import { RelationshipDirectoryContext } from '../../src/renderer/src/lib/contactRelationship';
import { MemberProfileCard } from '../../src/renderer/src/components/MemberProfileCard';
import { TitleBar } from '../../src/renderer/src/im-template/template/TitleBar';
import { MobileWebNavigation } from '../../src/renderer/src/components/MobileWebNavigation';
import { OnlineStatus } from '../../src/renderer/src/components/OnlineStatus';
import { ContactList } from '../../src/renderer/src/im-template/template/conversationLists';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

const statusEntryQa = { selections: 0 };
Object.assign(window, {
  selfProfileQa: qa,
  profileDisplayQa: displayQa,
  selfStatusEntryQa: statusEntryQa,
});
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
  const contact = {
    ...data,
    id: params.has('other') ? 'u_other' : 'u_self',
    uid: params.has('other') ? 'u_other' : 'u_self',
    username: data.nick,
    identityLabel: 'QQ',
    identityValue: params.has('other') ? '10002' : data.uin,
    displayName: data.nick,
    avatarUrl: '/_avatar/synthetic',
    createdAt: '',
  };
  if (params.has('titlebar')) return <TitleBar user={contact} />;
  if (params.has('mobile-header'))
    return (
      <div className="weq-web-shell">
        <MobileWebNavigation
          user={contact}
          view="messages"
          hidden={false}
          query=""
          onQueryChange={() => {}}
          messageBadgeCount={0}
          contactBadgeCount={0}
          onViewChange={() => {}}
          onOpenSettings={() => {}}
          onOpenDressUp={() => {}}
          onOpenCollection={() => {}}
        />
      </div>
    );
  if (params.has('self-chat-status')) return <OnlineStatus uid="u_self" showBaseStatus />;
  if (params.has('directory'))
    return (
      <ContactList
        contacts={[
          {
            ...contact,
            onlineStatusObj: {
              uid: 'u_self',
              type: 10,
              typeName: '在线',
              subType: 0,
              displayStatus: '在线',
            },
          },
        ]}
        activeContactId={null}
        onSelect={() => {
          statusEntryQa.selections++;
        }}
      />
    );
  if (params.has('member'))
    return <MemberProfileCard member={contact} anchor={{ x: 100, y: 80 }} onClose={() => {}} />;
  return (
    <main
      className="weq-self-profile-page"
      style={{ height: '100%', maxWidth: 1180, margin: '0 auto' }}
    >
      <ContactProfileDialog
        embedded={!params.has('popover')}
        onClose={() => {}}
        contact={contact}
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
