import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ensureThemeInitialized } from '../../src/renderer/src/state/theme';
import { createTemplateDemoData } from '../support/templateDemoData';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();

const seed = createTemplateDemoData().conversations.find((row) => row.type === 'direct')!;
const avatar =
  'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="%23757575"/></svg>';
const initial = {
  ...seed,
  id: 'u_fixture',
  unreadCount: 0,
  otherUser: { ...seed.otherUser!, avatarUrl: avatar, displayName: '未读回归会话' },
};
function App() {
  const [conversations, setConversations] = useState([
    initial,
    { ...initial, id: '70001', otherUser: { ...initial.otherUser, displayName: '批量回显会话' } },
  ]);
  useEffect(() => {
    const refresh = async () => {
      const rows = (await fetch('/__unread').then((response) => response.json())) as Array<{
        uid: string;
        readError?: boolean;
        unreadCount: number;
      }>;
      if (rows.some((row) => row.readError)) throw new Error('未读读取失败');
      setConversations((current) =>
        current.map((conversation) => ({
          ...conversation,
          unreadCount: rows.find((row) => row.uid === conversation.id)!.unreadCount,
        })),
      );
      return rows[0]!.unreadCount;
    };
    Object.assign(window, { unreadQa: { refresh } });
    void refresh();
  }, []);
  return (
    <ContentSelectionProvider>
      <style>{`html,body,#root{height:100%;margin:0}.app-shell{display:block;width:360px;max-width:100%;height:100%;min-width:0}.sidebar{width:100%;height:100%}`}</style>
      <div className="app-shell-root weq-web-shell" style={{ height: '100%' }}>
        <div className="app-shell">
          <aside className="sidebar">
            <ConversationList
              conversations={conversations}
              activeConversationId={null}
              preferences={{}}
              drafts={{}}
              onSelect={() => {}}
            />
          </aside>
        </div>
      </div>
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
