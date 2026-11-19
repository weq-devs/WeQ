import { createRoot } from 'react-dom/client';
import { ChatShell } from '../../src/renderer/src/im-template/template/chatShell';
import { ChatMainContent } from '../../src/renderer/src/im-template/template/chatMainContent';
import {
  useChatShellController,
  noopChatShellHistoryAdapter,
} from '../../src/renderer/src/im-template/template/shellController';
import { RelationGraphView } from '../../src/renderer/src/components/relationGraph/RelationGraphView';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';

ensureThemeInitialized();
Object.assign(window, { contactOverviewQa: { theme: useThemeStore } });
const demo = createTemplateDemoData(1793872800000);
const directory = Array.from({ length: 60 }, (_, i) => `合成联系人 ${i + 1}`);
const noop = () => {};
function Fixture() {
  const shell = useChatShellController({
    initialView: 'contacts',
    initialActiveConversationId: null,
    contacts: demo.contacts,
    conversations: demo.conversations,
    sidebarWidthStorageKey: 'contact-overview-qa',
    history: noopChatShellHistoryAdapter,
  });
  return (
    <ContentSelectionProvider>
      <ChatShell
        user={demo.user}
        view={shell.view}
        query={shell.query}
        contactTab={shell.contactTab}
        activeNotice={shell.contactNotice}
        contactOverviewActive={shell.contactOverviewOpen}
        sidebarWidth={shell.sidebarWidth}
        mainOpen={shell.mainOpen}
        messageBadgeCount={0}
        contactBadgeCount={2}
        friendNoticeCount={1}
        groupNoticeCount={1}
        sidebarContent={
          <div data-directory-scroll style={{ overflow: 'auto', height: '100%' }}>
            {directory.map((name) => (
              <div
                key={name}
                style={{ padding: 12, borderBottom: '1px solid var(--weq-border-subtle)' }}
              >
                {name}
              </div>
            ))}
          </div>
        }
        mainContent={
          <ChatMainContent
            user={demo.user}
            view={shell.view}
            contactTab={shell.contactTab}
            contactOverviewOpen={shell.contactOverviewOpen}
            onBackContactOverview={shell.backContactOverview}
            relationGraphSlot={<RelationGraphView />}
            messages={[]}
            loadingMessages={false}
            conversationPrefs={{}}
            drafts={{}}
            onBackContact={shell.backContact}
            onBackGroup={shell.backGroup}
            onBackConversation={shell.backConversation}
            onSend={async () => {}}
            onDraftChange={noop}
            onDraftClear={noop}
          />
        }
        onViewChange={shell.switchView}
        onQueryChange={shell.setQuery}
        onContactTabChange={shell.changeContactTab}
        onSidebarWidthChange={shell.updateSidebarWidth}
        onOpenContactOverview={shell.openContactOverview}
        onOpenFriendNotices={() => shell.openContactNotice('friend')}
        onOpenGroupNotices={() => shell.openContactNotice('group')}
        onOpenSettings={noop}
        onOpenCollection={noop}
        onOpenDressUp={noop}
        onOpenProfile={noop}
        onOpenAbout={noop}
        onOpenInvite={noop}
        onOpenWonderfulTools={noop}
        onOpenAntiRecall={noop}
        onOpenDbRepair={noop}
        onOpenQzoneAlbum={noop}
      />
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
