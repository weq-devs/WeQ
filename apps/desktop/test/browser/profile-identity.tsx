import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  ContactProfileDialog,
  GroupProfileDialog,
} from '../../src/renderer/src/im-template/template/profilePanes';
import {
  ChatNavigationContext,
  GroupMessagePreviewContext,
} from '../../src/renderer/src/lib/chatNavigation';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { ContactWorkspaceNavigationContext } from '../../src/renderer/src/lib/profileNavigation';
import type { Contact, GroupConversation } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';

ensureThemeInitialized();
const qa = { store: useThemeStore, chats: 0, previews: 0, expands: 0, closes: 0 };
Object.assign(window, { profileIdentityQa: qa });
const params = new URLSearchParams(location.search);
const embedded = !params.has('popover');
const name = params.has('short')
  ? '合成名称'
  : params.has('unbroken')
    ? 'SyntheticUnbrokenProfileName'.repeat(5)
    : '合成资料名称：用于检查好友和群聊资料中的长名称能够完整换行显示而不被截断';
const person: Contact = {
  id: 'u_fixture',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'fixture',
  displayName: name,
  nick: name,
  avatarUrl: null,
  createdAt: new Date(0).toISOString(),
};
const group: GroupConversation = {
  id: '20001',
  type: 'group',
  updatedAt: new Date(0).toISOString(),
  lastMessage: null,
  otherUser: null,
  members: [],
  group: {
    id: '20001',
    identityLabel: '群号',
    identityValue: '20001',
    name,
    avatarUrl: null,
    announcement: null,
    memberCount: 20,
  },
};
const openChat = () => qa.chats++;
const openPreview = () => qa.previews++;
const noop = () => {};
const close = () => qa.closes++;

createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ChatNavigationContext.Provider value={openChat}>
      <GroupMessagePreviewContext.Provider
        value={{ open: openPreview, close: noop, conversationId: null, content: null }}
      >
        <style>{`
        html,body,#root{height:100%;margin:0;overflow:hidden}
        .profile-identity-fixture{height:100%;max-width:1180px;margin:auto}
      `}</style>
        <ContactWorkspaceNavigationContext.Provider
          value={params.has('controls') ? () => qa.expands++ : null}
        >
          <main className="profile-identity-fixture">
            {params.has('friend') ? (
              <ContactProfileDialog
                contact={person}
                embedded={embedded}
                onClose={close}
                onPreviewChat={openPreview}
              />
            ) : (
              <GroupProfileDialog conversation={group} embedded={embedded} onClose={close} />
            )}
          </main>
        </ContactWorkspaceNavigationContext.Provider>
      </GroupMessagePreviewContext.Provider>
    </ChatNavigationContext.Provider>
  </QueryClientProvider>,
);
