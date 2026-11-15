import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SettingsDialog } from '../../src/renderer/src/components/SettingsDialog';
import { WorkspaceContent, WorkspacePages } from '../../src/renderer/src/components/WorkspacePages';
import { ChatPane } from '../../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../support/templateDemoData';
import { acceptPreferences } from '../../src/renderer/src/lib/clientPreferences';
import { useThemeStore } from '../../src/renderer/src/state/theme';
import type { PreferencePatch } from '@weq/service/client-preferences';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/styles/mobile-web.css';
import '../../src/renderer/src/im-template/styles.css';

const demo = createTemplateDemoData();
const source = demo.conversations.find((row) => row.type === 'group')!;
const member = {
  ...demo.user,
  id: 'u_member',
  identityValue: '10002',
  displayName: '本地群昵称',
  nick: '公开昵称',
  role: 'owner',
  memberLevel: 42,
  customTitle: '测试专属头衔',
  levelName: '活跃成员',
  joinedAt: '',
};
const conversation = { ...source, members: [member], unreadCount: 0 };
const settings = new URLSearchParams(location.search).get('settings');
let revision = 0;
Object.assign(window, {
  groupChatSettings: {
    preferences: (values: PreferencePatch) =>
      acceptPreferences({ revision: ++revision, values, records: {} }, false),
    theme: useThemeStore,
  },
});
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <WorkspacePages navigationKey="fixture">
      <div
        className="weq-web-shell"
        style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}
      >
        <WorkspaceContent>
          <ChatPane
            user={demo.user}
            conversation={conversation}
            messages={[
              {
                id: 'quote-target',
                conversationId: conversation.id,
                senderId: member.id,
                msgSeq: '120',
                body: '用于验证群消息显示与引用操作。',
                createdAt: '2026-11-15T10:00:00Z',
              },
            ]}
            loading={false}
            draft=""
            onDraftChange={() => {}}
            onDraftClear={() => {}}
            sendAvailable
            onSend={async () => {}}
            onBack={() => {}}
          />
        </WorkspaceContent>
        {settings ? (
          <SettingsDialog
            open
            initialSection={settings === 'display' ? 'message-display' : 'chat-interaction'}
            onClose={() => {}}
            onOpenMaintenance={() => {}}
            onOpenRecalls={() => {}}
          />
        ) : null}
      </div>
    </WorkspacePages>
  </QueryClientProvider>,
);
