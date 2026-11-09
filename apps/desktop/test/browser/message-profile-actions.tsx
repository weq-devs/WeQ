import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GroupProfileDialog } from '../../src/renderer/src/im-template/template/profilePanes';
import { GapMessagesModal } from '../../src/renderer/src/components/compose/GapMessagesModal';
import {
  ChatNavigationContext,
  GroupMessagePreviewContext,
} from '../../src/renderer/src/lib/chatNavigation';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import type { GroupConversation, User } from '../../src/renderer/src/im-template/template/types';
import '../../src/renderer/src/styles/index.css';

const user: User = {
  id: 'u_fixture',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'fixture',
  displayName: '合成成员',
  avatarUrl: null,
};
const conversation: GroupConversation = {
  id: '20001',
  type: 'group',
  otherUser: null,
  group: {
    id: '20001',
    name: '合成群聊',
    identityLabel: '群号',
    identityValue: '20001',
    avatarUrl: null,
    memberCount: 12,
    announcement: '合成群公告',
  },
  members: [user],
  updatedAt: '',
  lastMessage: null,
  unreadCount: 0,
  preference: {
    pinned: false,
    muted: false,
    blocked: false,
  },
};
const params = new URLSearchParams(location.search);
useThemeStore.getState().setPreference(params.has('dark') ? 'dark' : 'light');
useThemeStore.getState().setAccent(params.has('dark') ? '#e08aa0' : '#287b53');
function Fixture() {
  const [preview, setPreview] = useState(false);
  const [opened, setOpened] = useState(false);
  return (
    <div style={{ height: '100dvh', display: 'flex' }}>
      <ChatNavigationContext.Provider value={() => setOpened(true)}>
        <GroupMessagePreviewContext.Provider
          value={{
            open: () => setPreview(true),
            close: () => setPreview(false),
            conversationId: preview ? conversation.id : null,
            content: preview ? (
              <GapMessagesModal
                preview
                embedded
                conversation={conversation}
                user={user}
                messages={[]}
                loading={false}
                loadingMore={false}
                error={null}
                hasMore={false}
                moreFailed={false}
                totalCount={0}
                onLoadMore={() => {}}
                onClose={() => setPreview(false)}
              />
            ) : null,
          }}
        >
          <GroupProfileDialog
            embedded={!params.has('popover')}
            conversation={conversation}
            onClose={() => {}}
            details={<section aria-label="合成群详情">群资料内容</section>}
          />
        </GroupMessagePreviewContext.Provider>
      </ChatNavigationContext.Provider>
      {opened ? <output>已查看群消息</output> : null}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
