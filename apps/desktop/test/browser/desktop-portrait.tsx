import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatShell } from '../../src/renderer/src/im-template/template/chatShell';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { useChatShellController } from '../../src/renderer/src/im-template/template/shellController';
import { createTemplateDemoData } from '../support/templateDemoData';
import type { Conversation, Message } from '../../src/renderer/src/im-template/template/types';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import { isSingleColumnLayout } from '../../src/renderer/src/lib/responsiveLayout';
import { MediaPreviewShell } from '../../src/renderer/src/components/MediaPreviewShell';
import previewImage from '@resources/brand/logo.png';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/workspace-tools.css';

ensureThemeInitialized();
Object.assign(window, { desktopPortraitQa: { store: useThemeStore } });
const demo = createTemplateDemoData(1793872800000);
const user = { ...demo.user, displayName: '我', avatarUrl: null };
const peer = { ...demo.contacts[0], displayName: '林夏', avatarUrl: null };
const seed = demo.conversations.find((row) => row.type === 'direct')!;
const directConversation = { ...seed, id: 'portrait-fixture', otherUser: peer, unreadCount: 0 };
const groupSeed = demo.conversations.find((row) => row.type === 'group')!;
const groupConversation = { ...groupSeed, id: 'portrait-group-fixture', unreadCount: 0 };
const groupMode = new URLSearchParams(location.search).has('group');
const conversation = groupMode ? groupConversation : directConversation;
const names = ['林夏', '项目讨论', '文件传输', '周末出行', '读书小组', '设计讨论', '消息归档'];
const conversations: Conversation[] = names.map((name, index) =>
  groupMode
    ? {
        ...groupConversation,
        id: index === 0 ? conversation.id : `fixture-${index}`,
        group: { ...groupConversation.group, name },
      }
    : {
        ...directConversation,
        id: index === 0 ? conversation.id : `fixture-${index}`,
        otherUser: { ...peer, displayName: name },
      },
);
const messages: Message[] = [
  '这版会话列表看起来清楚多了。',
  '我把控件间距也整理了一下，稍后一起看。',
  '好的，搜索框和输入区保持简洁就行。',
  '收到。长消息也检查过了：在较窄的窗口里，文字会自然换行，不会挤到头像或旁边的工具按钮。',
  '明天下午见。',
].map((body, index) => ({
  id: `message-${index}`,
  conversationId: conversation.id,
  senderId: index % 2 ? user.id : peer.id,
  sender: index % 2 ? user : peer,
  body,
  createdAt: new Date(1793872800000 + index * 60000).toISOString(),
}));
const noop = () => {};

function DesktopFixture() {
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    Object.assign(window, { openWindowLayoutPreview: () => setPreview(true) });
  }, []);
  const shell = useChatShellController({
    conversations,
    contacts: [peer],
    conversationPrefs: {},
    initialActiveConversationId: conversation.id,
    sidebarWidthStorageKey: 'portrait-fixture-width',
    history: {
      isMobileShell: isSingleColumnLayout,
      shouldAutoSelectConversation: () => false,
      replaceShell: noop,
      pushShellDetail: noop,
      pushConversationDetail: noop,
    },
  });
  return (
    <ContentSelectionProvider>
      {preview && (
        <MediaPreviewShell title="窗口适配预览" onClose={() => setPreview(false)}>
          <img src={previewImage} alt="WeQ" width={220} height={220} />
        </MediaPreviewShell>
      )}
      <ChatShell
        user={user}
        view={shell.view}
        query={shell.query}
        contactTab={shell.contactTab}
        activeNotice={shell.contactNotice}
        sidebarWidth={shell.view === 'home' ? 0 : shell.sidebarWidth}
        mainOpen={shell.mainOpen}
        messageBadgeCount={0}
        contactBadgeCount={0}
        friendNoticeCount={0}
        groupNoticeCount={0}
        sidebarContent={
          <ConversationList
            user={user}
            conversations={conversations}
            activeConversationId={shell.activeConversationId}
            preferences={{}}
            drafts={{}}
            onSelect={shell.selectConversation}
          />
        }
        mainContent={
          shell.view === 'home' ? (
            <div data-portrait-home>主页内容</div>
          ) : (
            <ChatPane
              user={user}
              conversation={shell.activeConversation ?? conversation}
              messages={messages}
              draft={draft}
              atLatest
              tabActive
              onSend={async () => {}}
              onDraftChange={(_conversationId, value) => setDraft(value)}
              onDraftClear={() => setDraft('')}
              onBack={shell.backConversation}
              onStartCall={async () => {}}
              onSearchChatRecords={noop}
              onOpenConversationSettings={noop}
              onViewDeleted={noop}
              onViewRecalled={noop}
            />
          )
        }
        onViewChange={shell.switchView}
        onGoHome={() => shell.switchView('home')}
        onQueryChange={shell.setQuery}
        onContactTabChange={shell.changeContactTab}
        onSidebarWidthChange={shell.updateSidebarWidth}
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
        onOpenFriendNotices={noop}
        onOpenGroupNotices={noop}
      />
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<DesktopFixture />);
