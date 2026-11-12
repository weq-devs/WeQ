import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationList } from '../../src/renderer/src/im-template/template/conversationLists';
import type { Conversation } from '../../src/renderer/src/im-template/template/types';
import { createTemplateDemoData } from '../support/templateDemoData';
import { ContentSelectionProvider } from '../../src/renderer/src/state/contentSelection';
import { ConversationDirectoryContext } from '../../src/renderer/src/lib/conversationDirectory';
import { acceptPreferences } from '../../src/renderer/src/lib/clientPreferences';
import { ensureThemeInitialized, useThemeStore } from '../../src/renderer/src/state/theme';
import '../../src/renderer/src/styles/index.css';
import '../../src/renderer/src/im-template/styles.css';
import '../../src/renderer/src/styles/mobile-web.css';

ensureThemeInitialized();
const seed = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
const row = (id: string, day: number): Conversation => ({
  ...seed,
  id,
  group: {
    ...seed.group!,
    id,
    name: id === '10001' ? '产品讨论组' : '一段用于验证两行排版的很长很长的同名群聊标题',
    remark: '',
  },
  updatedAt: `2030-01-${String(day).padStart(2, '0')}T00:00:00Z`,
  lastMessage: null,
  unreadCount: day,
  preference: { pinned: false, muted: false, blocked: false },
});
let revision = 0;
function Fixture() {
  const [rows, setRows] = useState([row('10001', 2), row('10002', 1)]);
  const [selected, setSelected] = useState('');
  const [marked, setMarked] = useState<string[]>([]);
  Object.assign(window, {
    conversationContextQa: {
      theme: useThemeStore,
      enable: (enabled: boolean) =>
        acceptPreferences(
          {
            epoch: 'conversation-context-qa',
            revision: ++revision,
            values: { keepConversationPositionOnHover: enabled },
            records: {},
          },
          false,
        ),
      update: () => setRows([row('10001', 2), row('10002', 3)]),
    },
  });
  return (
    <ContentSelectionProvider>
      <ConversationDirectoryContext.Provider
        value={{
          virtual: [],
          onVirtual: () => {},
          onCreate: () => {},
          onReadState: (targets) => setMarked(targets.map((target) => target.id)),
        }}
      >
        <style>{`html,body,#root{height:100%;margin:0}.context-fixture{height:100%;display:flex}.context-fixture .app-shell{display:block;width:min(360px,100%);height:100%;min-width:0}.context-fixture .sidebar{width:100%;height:100%}.qa-output{position:fixed;right:8px;bottom:8px}`}</style>
        <div className="context-fixture app-shell-root weq-web-shell">
          <div className="app-shell">
            <aside className="sidebar">
              <div className="sidebar-body">
                <ConversationList
                  conversations={rows}
                  activeConversationId="10002"
                  preferences={{}}
                  drafts={{}}
                  onSelect={setSelected}
                />
              </div>
            </aside>
          </div>
          <output className="qa-output" data-selected={selected} data-marked={marked.join(',')} />
        </div>
      </ConversationDirectoryContext.Provider>
    </ContentSelectionProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
