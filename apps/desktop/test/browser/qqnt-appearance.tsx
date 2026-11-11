import { createRoot } from 'react-dom/client';
import { useState, type CSSProperties } from 'react';
import { Moon, Sun } from 'lucide-react';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { AppRail } from '../../src/renderer/src/im-template/template/rail';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { createTemplateDemoData } from '../support/templateDemoData';
import type { Message } from '../../src/renderer/src/im-template/template/types';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { MergedSessionPanel } from '../../src/renderer/src/components/sidebar/MergedSessionPanel';
import { SidebarHeader } from '../../src/renderer/src/im-template/template/sidebarHeader';
import { ContactList } from '../../src/renderer/src/im-template/template/conversationLists';
import { contrastRatio } from '../../src/shared/theme_colors';
import {
  componentStyles,
  ensureThemeInitialized,
  useThemeStore,
} from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
useThemeStore.getState().setComponentStyle('qqnt');
useThemeStore.getState().setBackground('plain');
useThemeStore.getState().setAccent('');
Object.assign(window, { qqntQa: { store: useThemeStore, contrastRatio, componentStyles } });
const demo = createTemplateDemoData(1793872800000);
function avatar(label: string, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 80;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 80, 80);
  ctx.fillStyle = '#ffffff';
  ctx.font = '36px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 40, 42);
  return canvas.toDataURL();
}
const user = { ...demo.user, displayName: '我', avatarUrl: avatar('W', '#357566') };
const peer = { ...demo.contacts[0], displayName: '林夏', avatarUrl: avatar('林', '#53769c') };
const seed = demo.conversations.find((row) => row.type === 'direct')!;
const conversation = { ...seed, id: 'qqnt-fixture', otherUser: peer, unreadCount: 0 };
const names = ['林夏', '项目讨论', '文件传输', '周末出行', '读书小组', '设计讨论', '消息归档'];
const conversations = names.map((name, index) => ({
  ...conversation,
  id: index === 0 ? conversation.id : `fixture-${index}`,
  otherUser: {
    ...peer,
    displayName: name,
    avatarUrl: avatar(name.slice(0, 1), index % 2 ? '#6d8061' : '#53769c'),
  },
  unreadCount: index === 0 ? 3 : index === 1 ? 68 : 0,
  preference: { ...conversation.preference, muted: index === 1 },
  lastMessage: {
    id: `last-${index}`,
    senderId: peer.id,
    body: ['明天下午见。', '新版的界面已经整理好了。', '设计说明.pdf'][index % 3],
    createdAt: new Date(1793872800000 - index * 60000).toISOString(),
  },
}));
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
const groupSeed = demo.conversations.find((row) => row.type === 'group')!;
const groups = names.map((name, index) => ({
  ...groupSeed,
  id: `group-fixture-${index}`,
  group: { ...groupSeed.group!, name, avatarUrl: peer.avatarUrl },
  lastMessage: conversations[index].lastMessage,
  unreadCount: index === 1 ? 68 : index + 1,
  preference: { ...groupSeed.preference, muted: index === 1, pinned: index === 1 },
}));
function Fixture() {
  const desktop = new URLSearchParams(location.search).has('desktop');
  const [draft, setDraft] = useState('');
  const [detail, setDetail] = useState(true);
  const [assistant, setAssistant] = useState(new URLSearchParams(location.search).has('assistant'));
  const theme = useThemeStore((state) => state.resolved);
  const style = useThemeStore((state) => state.componentStyle);
  const contactsView = new URLSearchParams(location.search).has('contacts');
  return (
    <ContentSelectionProvider>
      <div
        className={`app-shell-root${desktop ? '' : ' weq-web-shell'}`}
        data-mobile-detail={!contactsView && detail ? true : undefined}
        style={{ '--sidebar-width': '268px' } as CSSProperties}
      >
        <header className="app-title-bar" style={{ padding: '0 12px', gap: 12, flexShrink: 0 }}>
          <strong>WeQ</strong>
          <button
            type="button"
            className="weq-set-btn weq-set-btn-soft"
            onClick={() => setAssistant(true)}
          >
            群助手
          </button>
          <select
            aria-label="组件风格"
            value={style}
            onChange={(event) =>
              useThemeStore.getState().setComponentStyle(event.target.value as typeof style)
            }
          >
            {componentStyles.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="icon-button"
            aria-label="切换深浅色"
            title="切换深浅色"
            onClick={() =>
              useThemeStore.getState().setPreference(theme === 'dark' ? 'light' : 'dark')
            }
          >
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </header>
        <div className="app-shell">
          <AppRail
            user={user}
            view={contactsView ? 'contacts' : 'messages'}
            onViewChange={noop}
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
            hideAvatar
          />
          <aside className="sidebar">
            {contactsView ? (
              <>
                <SidebarHeader
                  user={user}
                  view="contacts"
                  query=""
                  onQueryChange={noop}
                  onOpenProfile={noop}
                  onOpenFriendNotices={noop}
                  onOpenGroupNotices={noop}
                  contactTab="friends"
                  onContactTabChange={noop}
                  onRefreshContacts={noop}
                  showSearch={false}
                  activeNotice={null}
                />
                <ContactList contacts={[peer]} activeContactId={peer.id} onSelect={noop} />
              </>
            ) : (
              <ConversationList
                user={user}
                conversations={conversations}
                activeConversationId={conversation.id}
                preferences={{}}
                drafts={{}}
                onSelect={() => setDetail(true)}
              />
            )}
          </aside>
          <section className={`chat-main${detail ? ' chat-main-open' : ''}`}>
            <ChatPane
              user={user}
              conversation={conversation}
              messages={messages}
              draft={draft}
              atLatest
              tabActive
              onSend={async () => {}}
              onDraftChange={setDraft}
              onDraftClear={() => setDraft('')}
              onBack={() => setDetail(false)}
            />
          </section>
        </div>
      </div>
      {assistant ? (
        <MergedSessionPanel
          kind="groupAssistant"
          conversations={groups}
          groupAssistantIds={new Set(groups.map((row) => row.id))}
          anchorX={70}
          anchorY={100}
          onBack={() => setAssistant(false)}
          onSelectConversation={noop}
        />
      ) : null}
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
